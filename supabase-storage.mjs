// supabase-storage.mjs
//
// Supabase Storage layer for CV files.
//
// Replaces the old "write to local disk" approach: Render's filesystem is
// ephemeral, so CVs uploaded through the dashboard were lost on every
// redeploy. CVs now live in a public Supabase Storage bucket ("cvs") and the
// bucket's public URL is stored in the cvs.file_path column.
//
// SETUP:
//   1. Add to .env:
//        SUPABASE_URL=https://<project-ref>.supabase.co
//        SUPABASE_SERVICE_KEY=<service_role key — server-side only!>
//   2. The "cvs" bucket is created automatically on API startup if missing.
//
// NOTE: This module is intentionally import-safe when the env vars are
// missing (the client is created lazily, per call) so it can be imported
// from scripts that run without Supabase configured (e.g. GitHub Actions).

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { unlink } from 'node:fs/promises';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CV_BUCKET = 'cvs';

let client = null;

/**
 * True when both SUPABASE_URL and SUPABASE_SERVICE_KEY are set.
 * Callers use this to return a clean, actionable error instead of crashing.
 */
export function isSupabaseConfigured() {
    return Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
}

/**
 * Lazily creates (and caches) the Supabase client using the service role key.
 * The service key bypasses RLS — it must NEVER be exposed to the frontend.
 *
 * @returns {SupabaseClient}
 * @throws {Error} if SUPABASE_URL / SUPABASE_SERVICE_KEY are not configured
 */
export function getSupabaseClient() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        throw new Error(
            'Supabase Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.'
        );
    }
    if (!client) {
        client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false },
        });
    }
    return client;
}

/**
 * Ensures the "cvs" bucket exists. Safe to call on every startup — a bucket
 * that already exists is not an error.
 *
 * @returns {Promise<void>}
 */
export async function ensureCvBucket() {
    if (!isSupabaseConfigured()) {
        console.warn('Supabase Storage not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY missing) — CV uploads will be unavailable.');
        return;
    }

    try {
        const supabase = getSupabaseClient();
        const { error } = await supabase.storage.createBucket(CV_BUCKET, {
            public: true,
            fileSizeLimit: 10 * 1024 * 1024, // 10MB, mirrors the API-side limit
        });

        // "Bucket already exists" errors are fine on restart.
        if (error && !/already exists|duplicate/i.test(`${error.message} ${error.name}`)) {
            throw error;
        }
        console.log(`Supabase Storage bucket "${CV_BUCKET}" is ready.`);
    } catch (err) {
        console.error(`Failed to ensure Supabase bucket "${CV_BUCKET}":`, err.message);
    }
}

/**
 * Uploads a CV buffer to the cvs bucket and returns its public URL.
 *
 * @param {Buffer} buffer - the file contents
 * @param {string} storedName - sanitized object name inside the bucket (e.g. "cv-1727...pdf")
 * @param {string} [mimeType='application/pdf']
 * @returns {Promise<string>} public URL of the uploaded object
 */
export async function uploadCvToStorage(buffer, storedName, mimeType = 'application/pdf') {
    const supabase = getSupabaseClient();

    const { error } = await supabase.storage
        .from(CV_BUCKET)
        .upload(storedName, buffer, {
            contentType: mimeType,
            upsert: false, // storedName embeds a timestamp, collisions are practically impossible
        });

    if (error) {
        throw new Error(`Supabase upload failed: ${error.message}`);
    }

    const { data } = supabase.storage.from(CV_BUCKET).getPublicUrl(storedName);
    if (!data?.publicUrl) {
        throw new Error('Supabase upload succeeded but no public URL was returned.');
    }
    return data.publicUrl;
}

/**
 * Deletes an object from the cvs bucket given its public URL
 * (the value stored in cvs.file_path). If given something that is not a
 * Supabase URL, it is treated as a legacy local-disk path and removed from
 * disk instead — keeps old uploads cleanable after the migration.
 *
 * @param {string} fileRef - public URL or legacy local path
 * @returns {Promise<{deleted: boolean, kind: 'storage'|'disk'|'none'}>}
 */
export async function deleteCvFile(fileRef) {
    if (!fileRef) return { deleted: false, kind: 'none' };

    // Supabase public URLs look like:
    //   https://<ref>.supabase.co/storage/v1/object/public/cvs/<objectName>
    const marker = `/storage/v1/object/public/${CV_BUCKET}/`;
    const markerIndex = fileRef.indexOf(marker);

    if (markerIndex !== -1) {
        const objectName = fileRef.slice(markerIndex + marker.length).split('?')[0];
        if (!objectName) return { deleted: false, kind: 'none' };

        const supabase = getSupabaseClient();
        const { error } = await supabase.storage.from(CV_BUCKET).remove([objectName]);
        if (error) {
            throw new Error(`Supabase delete failed: ${error.message}`);
        }
        return { deleted: true, kind: 'storage' };
    }

    // Legacy local path — best-effort cleanup, ignore if already gone.
    if (/^https?:\/\//i.test(fileRef)) {
        return { deleted: false, kind: 'none' }; // some other URL, nothing we manage
    }
    await unlink(path.resolve(fileRef)).catch(() => {});
    return { deleted: true, kind: 'disk' };
}

/**
 * Downloads a CV from its Supabase public URL and returns the raw Buffer.
 * Used by gemini-scoring.mjs before uploading the CV to the Gemini Files API
 * (serverless/ephemeral hosts have no local copy of the file).
 *
 * @param {string} url - public URL stored in cvs.file_path
 * @returns {Promise<Buffer>}
 */
export async function downloadCvFromStorage(url) {
    if (!/^https?:\/\//i.test(url)) {
        throw new Error(`Not a downloadable URL: ${String(url).slice(0, 100)}`);
    }

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download CV from Supabase (HTTP ${response.status}). Check that the object still exists and the bucket is public.`);
    }

    return Buffer.from(await response.arrayBuffer());
}


#!/bin/bash
# fix-syntax.sh - Fix common syntax errors in .mjs files

echo "Fixing syntax errors in .mjs files..."

# Fix all .mjs files in the project
find . -name "*.mjs" -type f -not -path "./node_modules/*" -not -path "./dashboard/*" | while read -r file; do
    echo "Processing: $file"

    # Fix "? ?" -> "??"
    sed -i 's/\? \?/??/g' "$file"

    # Fix "? ." -> "?."
    sed -i 's/\? \./?./g' "$file"

    # Fix "? ?" -> "??" (double check)
    sed -i 's/\? \?/??/g' "$file"
done

echo "✅ Syntax fixed!"

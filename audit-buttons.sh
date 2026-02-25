#!/bin/bash

echo "=== BUTTON AUDIT ==="
echo ""

for file in ./public/*.html; do
  echo "FILE: $(basename $file)"
  
  # Find all buttons/links with onclick or href
  grep -o 'onclick="[^"]*"' "$file" | sort -u | while read onclick; do
    func=$(echo "$onclick" | sed 's/onclick="\([^"]*\)"/\1/' | sed 's/(.*//g')
    # Check if function is defined in the file
    if ! grep -q "function $func\|$func\s*=\|$func\s*:\|$func\s*function" "$file"; then
      echo "  ⚠ Missing handler: $onclick"
    fi
  done
  
  # Find href links
  grep -o 'href="[^"]*"' "$file" | grep -v "^href=\"http\|^href=\"/\|^href=\"#" | sort -u | while read href; do
    echo "  ℹ Link: $href"
  done
  
  echo ""
done

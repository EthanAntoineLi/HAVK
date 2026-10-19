#!/usr/bin/env bash
# Create a public GitHub repository from this folder, push it and enable GitHub Pages.
set -euo pipefail
cd "$(dirname "$0")"

REPO_NAME="${1:-HAVK}"

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required. Install it with:  brew install gh"
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "Not signed in to GitHub. Run:  gh auth login"
  exit 1
fi

# Make sure everything is committed.
if [ -d .git ] && [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "Update site"
fi

OWNER="$(gh api user -q .login)"
REMOTE_URL="https://github.com/$OWNER/$REPO_NAME.git"

if git remote get-url origin >/dev/null 2>&1; then
  echo "Pushing to existing origin"
  git push -u origin main
elif gh repo view "$OWNER/$REPO_NAME" >/dev/null 2>&1; then
  echo "Repository $OWNER/$REPO_NAME already exists; using it"
  git remote add origin "$REMOTE_URL"
  git push -u origin main
else
  echo "Creating public repository: $REPO_NAME"
  gh repo create "$REPO_NAME" --public \
    --description "Interactive 3D visualiser of a 5-DOF robotic arm (EPQ)" \
    --source=. --remote=origin --push
fi
REPO_URL="https://github.com/$OWNER/$REPO_NAME"
PAGES_URL="https://$OWNER.github.io/$REPO_NAME/"

# Put the real Pages URL into the README (once).
if grep -q "YOUR-GITHUB-USERNAME" README.md; then
  if sed --version >/dev/null 2>&1; then
    sed -i -e "s|YOUR-GITHUB-USERNAME|$OWNER|g" \
           -e "s|YOUR-REPO-NAME|$REPO_NAME|g" README.md
  else
    sed -i '' -e "s|YOUR-GITHUB-USERNAME|$OWNER|g" \
              -e "s|YOUR-REPO-NAME|$REPO_NAME|g" README.md
  fi
  git add README.md
  git commit -m "Add live demo link"
  git push
fi

# Enable (or update) GitHub Pages: main branch, repository root.
if gh api "repos/$OWNER/$REPO_NAME/pages" >/dev/null 2>&1; then
  gh api -X PUT "repos/$OWNER/$REPO_NAME/pages" \
    -H "Accept: application/vnd.github+json" \
    --input - >/dev/null <<'JSON'
{"source":{"branch":"main","path":"/"}}
JSON
else
  gh api -X POST "repos/$OWNER/$REPO_NAME/pages" \
    -H "Accept: application/vnd.github+json" \
    --input - >/dev/null <<'JSON'
{"source":{"branch":"main","path":"/"}}
JSON
fi

echo
echo "Repository: $REPO_URL"
echo "Live demo:  $PAGES_URL"
echo "GitHub Pages usually takes about a minute to publish."

# Publishing to GitHub

This folder is already a git repository with one commit. The web demo is
`index.html`, so GitHub Pages can serve it directly from the repository root.

## Easiest: GitHub CLI

Install the GitHub CLI once, sign in, then run the script:

```bash
brew install gh
gh auth login          # choose GitHub.com → HTTPS → login with a browser
bash publish.sh        # creates the public repo, pushes, enables Pages
```

`publish.sh` prints the repository and live-demo URLs. GitHub Pages normally takes
about a minute to build after it is enabled.

If you want a different repository name, pass it as the first argument:

```bash
bash publish.sh my-repo-name
```

## Manual route

1. Create a new **public** repository on GitHub (no README, no .gitignore).
2. In this folder run:

```bash
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

3. In the repository: **Settings → Pages → Build and deployment → Source: Deploy
   from a branch → Branch: `main` / root**, then save.
4. The demo appears at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

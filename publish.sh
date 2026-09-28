#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"

for command in git gh node; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required. Install it, then run this script again."
done

git rev-parse --show-toplevel >/dev/null 2>&1 || fail "This script must be inside the ismini-linux Git repository."
gh auth status >/dev/null 2>&1 || fail "GitHub CLI is not signed in. Run: gh auth login"

repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || fail "Could not identify this GitHub repository."
branch="$(git branch --show-current)"
[[ -n "$branch" ]] || fail "You are not on a branch."

default_ref="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD || true)"
default_branch="${default_ref#origin/}"
[[ -n "$default_branch" ]] || default_branch="main"
[[ "$branch" == "$default_branch" ]] || fail "Switch to the '$default_branch' branch before publishing (currently on '$branch')."

git diff --cached --quiet || fail "There are already staged changes. Commit or unstage them before running the publisher."

printf 'Checking GitHub for the latest commits and release tags...\n'
git fetch origin --tags || fail "Could not fetch from origin. Check your internet connection and GitHub access."
git show-ref --verify --quiet "refs/remotes/origin/$default_branch" || fail "Could not find origin/$default_branch."

read -r ahead behind < <(git rev-list --left-right --count "HEAD...origin/$default_branch")
[[ "$ahead" == "0" && "$behind" == "0" ]] || fail "Your '$default_branch' branch is not in sync with GitHub (ahead $ahead, behind $behind). Sync it before publishing."

if git diff --quiet -- . ':(exclude)sessions.json' &&
   [[ -z "$(git ls-files --others --exclude-standard -- . ':(exclude)sessions.json')" ]]; then
  fail "There are no project changes to publish (personal sessions.json changes are ignored)."
fi

current_version="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version)' 2>/dev/null)" ||
  fail "Could not read the version from package.json."
[[ "$current_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "package.json must use a major.minor.patch version (for example, 4.0.0)."

latest_tag="$(git tag --list 'v[0-9]*' --sort=-version:refname | head -n 1)"
latest_version="${latest_tag#v}"
version_floor="$current_version"
if [[ -n "$latest_version" ]] &&
   [[ "$(printf '%s\n%s\n' "$version_floor" "$latest_version" | sort -V | tail -n 1)" != "$version_floor" ]]; then
  version_floor="$latest_version"
fi

printf '\nCurrent package version: %s\nLatest release tag:      %s\n' \
  "$current_version" "${latest_tag:-none}"
read -r -p "New version (major.minor.patch, for example 4.0.1): " version
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Enter a version in major.minor.patch format."
[[ "$(printf '%s\n%s\n' "$version_floor" "$version" | sort -V | tail -n 1)" == "$version" &&
   "$version" != "$version_floor" ]] || fail "The new version must be greater than $version_floor."

tag="v$version"
if git show-ref --verify --quiet "refs/tags/$tag"; then
  fail "Tag $tag already exists."
fi

read -r -p "Commit message for this release: " commit_message
[[ -n "${commit_message//[[:space:]]/}" ]] || fail "A commit message is required."

printf '\nChanges to be included (sessions.json is intentionally excluded):\n'
git status --short -- . ':(exclude)sessions.json'
printf '\nThis will update package.json, commit and push the changes, tag %s, and create a GitHub Release.\n' "$tag"
printf 'GitHub will provide the source ZIP and TAR.GZ for this tag; no standalone binary is built.\n'
read -r -p "Type YES to publish: " confirmation
[[ "$confirmation" == "YES" ]] || fail "Cancelled. No project changes were staged or committed."

node - "$version" <<'NODE'
const fs = require("node:fs");
const path = "package.json";
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.version = process.argv[2];
fs.writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
NODE

git add -A -- . ':(exclude)sessions.json'
git rm --cached --ignore-unmatch -f -- sessions.json
git add --chmod=+x -- publish.sh
git diff --cached --check || fail "Staged changes have whitespace errors. Fix them before publishing."
git commit -m "$commit_message"
git tag -a "$tag" -m "ismini $tag"
git push --atomic origin "HEAD:$default_branch" "$tag"

if ! gh release create "$tag" --repo "$repo" --title "ismini $tag" --generate-notes --verify-tag; then
  fail "The commit and tag were pushed, but GitHub could not create the release. Check Releases before retrying."
fi

printf '\nPublished successfully: https://github.com/%s/releases/tag/%s\n' "$repo" "$tag"

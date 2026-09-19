# Exports the D1 database (all marks, locations, users) to a dated .sql file.
# Deliberately a LOCAL script, not a GitHub Action: this repo is public and
# Actions artifacts of a public repo can be downloaded by anyone, which would
# expose the catch history.
#
# Usage (from the repo folder, after `npx wrangler login`):
#   .\scripts\backup-d1.ps1                       # saves to ..\backups (next to the repo)
#   .\scripts\backup-d1.ps1 -OutDir D:\Backups    # or somewhere else
# Point OutDir OUTSIDE the repo and, ideally, outside any public sync folder.
# Older exports beyond the 12 newest are left in place - tidy them by hand.
param([string]$OutDir = (Join-Path (Split-Path $PSScriptRoot -Parent) "..\backups"))
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $OutDir | Out-Null
$file = Join-Path $OutDir ("fishingconditions-users-{0:yyyyMMdd-HHmm}.sql" -f (Get-Date))
npx wrangler d1 export fishingconditions-users --remote --output="$file"
"Saved $file"

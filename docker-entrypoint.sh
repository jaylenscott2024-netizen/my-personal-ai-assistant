#!/bin/sh
set -e

# Applies any pending migrations against whatever DATABASE_URL points at
# (a fresh SQLite file on first boot, or an existing one on redeploy),
# then starts the server. Keeping this in the entrypoint rather than baked
# into the image means a persistent volume's data survives image rebuilds.
npx prisma migrate deploy
exec node dist/server.js

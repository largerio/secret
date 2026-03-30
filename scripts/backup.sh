#!/bin/bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/secret/backups}/$(date +%Y%m%d_%H%M%S)"
DATA_DIR="${DATA_DIR:-/opt/secret/data}"

mkdir -p "$BACKUP_DIR"

if [ -f "$DATA_DIR/secret.db" ]; then
	cp "$DATA_DIR/secret.db" "$BACKUP_DIR/"
	echo "Database backed up to $BACKUP_DIR/secret.db"
fi

if [ -d "$DATA_DIR/files" ]; then
	cp -r "$DATA_DIR/files" "$BACKUP_DIR/"
	echo "Files backed up to $BACKUP_DIR/files/"
fi

echo "Backup completed: $BACKUP_DIR"

# TAPRA production workflow

- The authoritative local checkout is `C:\Projects\taprasystem`.
- Production is reached through the SSH alias `tapra-server`.
- Production lives at `/home/taprasystem/rahkar` and runs as the PM2 app `rahkar-taprasystem`.
- Every completed development change must pass lint, tests, typecheck, build, and the applicable security audit before it is committed and pushed to `main`.
- Deploy only through `ssh tapra-server "cd /home/taprasystem/rahkar && ./deploy.sh"`.
- Never edit production application files directly. Never overwrite or display `.env` and never commit secrets, `node_modules`, `.next`, `storage/uploads`, or `storage/backups`.
- After deployment, verify PM2, `http://127.0.0.1:3000/api/health`, `https://taprasystem.ir/api/health`, and recent application logs.
- Database migrations must be additive unless the user explicitly approves a destructive migration. The deployment script creates a database backup before applying migrations.

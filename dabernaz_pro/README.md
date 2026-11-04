# Dabernaz 2.0

Persian RTL game club with server-backed account registration/login, secure password hashing, session cookies, automatic 20-player Daberna rooms, automatic number draws, first-line/full-card winner tracking, and skill-based RPS/Tic-Tac-Toe.

## Run

Requires Node.js 18+. No external dependencies.

```bash
npm start
```

Open `http://localhost:8080`. User data is stored privately in `.private/store.json`. Do not expose or delete this directory.

For public multiplayer, deploy one Node.js server behind HTTPS. Payment, deposits, withdrawals, cash prizes, email verification, and password recovery are not enabled. See `README.fa.md` for Persian setup and deployment notes.

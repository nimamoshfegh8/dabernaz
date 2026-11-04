# Dabernaz

Server-backed player accounts and automated 20-player Daberna rooms. Includes a PHP API for regular cPanel hosting and a Node.js server for VPS/Node hosting.

- cPanel: upload/extract the archive contents directly into `public_html`; use PHP 8.1+; keep `.htaccess` and `.private/.htaccess`.
- Verify `https://YOUR-DOMAIN/api/health` returns JSON with `ok: true` and `backend: php`.
- Node.js: run `npm start` with Node 18+.

No payment gateway, deposits, withdrawals, paid entry, or cash prizes are enabled. See `README.fa.md` for complete Persian setup and troubleshooting instructions.

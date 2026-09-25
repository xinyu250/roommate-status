# Roommate status

Netlify hosts the HTML frontend and the native ESM function in `netlify/functions/api.mjs`.
The existing Express server (`npm start`) is for the original local workflow; Netlify does not use it.

## Netlify deployment

1. Set `LARK_APP_ID` and `LARK_APP_SECRET` in the Netlify environment variable settings. This site's plan requires the default scopes; restricting them to Functions produces HTTP 403. The values are server-side configuration and must never be included in published files.
2. Run `npm test` and `npm run build`.
3. Run `npx netlify deploy --no-build --dir dist --functions netlify/functions --site cb757c1d-8950-4e08-9e3b-c5e027ea7fbe`.
4. Check `/api/health` and `/api/roommates` on the returned preview URL.
5. Publish with the same command plus `--prod`.

Use `netlify login` or the `NETLIFY_AUTH_TOKEN` environment variable for CLI authentication. Never commit credentials.
For Git-based builds, `netlify.toml` builds the frontend into `dist`; only this directory is published as static content.

Optional server-side variables: `LARK_BASE_TOKEN`, `LARK_TABLE_ID`, `LARK_CHAT_ID`. Defaults retain the original app's table and chat.
The Feishu app must have access to that table and the existing messaging permissions.

## API behavior

- `GET /api/health`: `{ "ok": true }`.
- `GET /api/roommates`: reads current Feishu table records. Upstream failures return HTTP 502.
- `POST /api/roommates`: updates the matching name or creates a record; success is returned after persistence. Notification runs with `context.waitUntil`.
- `DELETE /api/roommates/:name`: deletes the matching record and acknowledges completion.

This retains the original shared app's unauthenticated API. Concurrent first-time submissions of the same name can still create duplicate rows because the table has no uniqueness constraint.

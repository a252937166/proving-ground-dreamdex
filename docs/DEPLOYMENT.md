# Static website deployment

Primary: https://marginrescue.axiqo.xyz/ on the existing Nginx server. Status: deployed and verified over HTTPS on 2026-10-28. The existing wildcard DNS is retained.

Secondary: https://a252937166.github.io/proving-ground-dreamdex/. Its GitHub Actions workflow continues to build from `main` with `SITE_BASE=/proving-ground-dreamdex/`; its Pages domain settings remain unchanged.

## Primary server release

1. From the intended checkout, run `npm run typecheck`, then `SITE_BASE=/ npm run build:site` using Node 22. The build writes `dist/site/` and refuses evidence that fails its publication checks.
2. Upload the contents of `dist/site/` to a new directory `/var/www/marginrescue/releases/<release>/`, using a unique release name such as a UTC timestamp and commit ID. Keep the previous release for rollback.
3. Use the [dedicated Nginx configuration](../deploy/nginx/marginrescue.conf) after bootstrapping the HTTP-only ACME host and obtaining its certificate. Configure the dedicated Nginx host for `marginrescue.axiqo.xyz`, with document root `/var/www/marginrescue/current`. It must serve extensionless routes such as `/app` from `app.html`. Obtain the host's certificate through the server's existing certbot setup and check `nginx -t` before reloading Nginx.
4. Activate the uploaded directory by replacing the `current` symlink atomically. On the server, with the intended release path in `TASK_RELEASE`:

   ```bash
   ln -s "$TASK_RELEASE" /var/www/marginrescue/current.next
   mv -Tf /var/www/marginrescue/current.next /var/www/marginrescue/current
   ```

5. Check the HTTPS homepage, `/app?run=live-1#result`, page assets and `/api/proof.json`. The app must show Live run 1 and `VERIFIED_COMPLETE`, with the independently verified goal and cleanup. Check `/evidence/live-write/run-1/verification.txt` against that result before marking the new domain ready for a post.

Rollback uses the same symlink replacement with the previous release directory. Each deployment switches the complete static artifact; subsequent GitHub Pages builds remain independent.

## Verified deployment (2026-10-28)

- The wildcard DNS already pointed to the existing server. No DNS record or GitHub Pages domain setting was changed.
- A dedicated `marginrescue` virtual host serves the root-path build and redirects HTTP to HTTPS while keeping the ACME webroot reachable. Missing routes return 404; hidden paths are denied. Unversioned assets and proof files use `Cache-Control: no-cache`.
- The host has its own Let's Encrypt certificate, valid through 2027-01-26. The existing certbot renewal timer and executable Nginx reload hook cover renewal; the ACME webroot is `/var/www/marginrescue/acme`.
- Seven page routes, scripts, fonts, brand assets, live-run JSON and raw evidence were read back over HTTPS. A browser analysis of the public six-market example reconciled EXACT at block 35,266,872 in 20.5 seconds. The result deep link selects Live run 1 with `VERIFIED_COMPLETE`, 93/93 independent checks and verified cleanup.
- The 12 pre-existing virtual-host configurations retained their hashes. Public HTTPS checks for the root site, Attest, ReviveCheck, its demo, SplitReceipt, ReCart and ArcPreflight matched their pre-deployment status and certificate hostnames.
- Verification counters are static values: they no longer animate through lower intermediate counts while a reader is assessing the evidence. This does not change the underlying checks or their results.

GitHub Pages remains the independently built fallback. Updating `main` rebuilds Pages; updating the primary server requires the root build and atomic release procedure above.

# vocat-yt-resolver

Optional Python resolver/streamer for the EchoEar VocAT Cloudflare Worker.
It exposes `/health`, `/resolve?id=VIDEO` and `/yt/VIDEO.aac`.

Use only with audio you are authorized to access and retransmit. This service does not bypass DRM or authentication.

## Render

- Runtime: Docker
- Plan: Free for testing
- Environment: `YT_KEY`, `PORT` (Render supplies this), `MAX_STREAMS=1`, `START_TIMEOUT=15`
- Health endpoint: `/health`

Cookies are not included in the repository. If authorized cookies are needed, provision them through a protected secret mechanism; never commit `cookies.txt`.

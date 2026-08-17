# Installation

One container, one volume, one published port. The image is published to GHCR:

```bash
docker pull ghcr.io/schubydoo/withe:latest
```

To build from source instead, run `docker build -t withe .` and use `withe` in place of the image
name below.

## Run it

```bash
docker run -d \
  --name withe \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp \
  --tmpfs /app/.next/cache \
  -p 127.0.0.1:8080:3000 \
  -v withe-data:/data \
  -e WITHE_CE_URL=https://renovate.example.lan \
  -e WITHE_CE_TOKEN=your-server-secret \
  ghcr.io/schubydoo/withe:latest
```

Open `http://127.0.0.1:8080`. If Renovate's API is not switched on, the preflight page names the
exact variables to set on the Renovate side.

Every flag earns its place:

- **`-p 127.0.0.1:8080:3000`** publishes to host loopback only — the real containment control. See
  [Exposure & TLS](exposure.md) before you change it.
- **`--restart unless-stopped`** is required: the supervisor exits after three consecutive start
  failures so the restart policy takes over. With no policy the container simply stops.
- **`--read-only` with the two `tmpfs` mounts** runs the root filesystem read-only; Withe writes only
  to `/data`, `/tmp`, and the Next.js cache.

## Docker Compose

```yaml
services:
  withe:
    image: ghcr.io/schubydoo/withe:latest   # or build: . from the repository
    container_name: withe
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp
      - /app/.next/cache
    ports:
      - "127.0.0.1:8080:3000"   # host loopback only — see Exposure
    volumes:
      - withe-data:/data
    environment:
      WITHE_CE_URL: https://renovate.example.lan
      WITHE_CE_TOKEN: ${WITHE_CE_TOKEN}

volumes:
  withe-data:
```

# MoST Dashboard Frontend

Frontend dashboard for visualizing experiment data served by MoST-API.

## Features

- Header with LLM name and GPU used (fetched from API)
- Experiment list on the left with selection highlight
- Per-experiment ZIP download including only `results.csv` files, preserving iteration folder structure
- Line chart in the center:
	- X axis: iteration count
	- Y axis: requests sent per minute
	- Stage 1 line in blue
	- Stage 2 line in orange
	- Circle node when evaluation is `TRUE`
	- Triangle node when evaluation is `FALSE`
- Tooltip on hover with date, RPM, evaluation, and success rate
- Detail panel on click showing full `results.csv` fields for the selected iteration
- Download buttons for `results.csv` and `results.json` in detail panel
- Warning confirmation before `results.json` download
- Automatic SSH tunnel startup when running `npm run dev`
- Tunnel status strip in the frontend with per-port controls:
	- switch active API source per port
	- restart each tunnel independently

## Install

```bash
npm install
```

## Configure API Base URL

The dashboard reads API base URL from `VITE_API_BASE_URL`.

Create `.env` from `.env.example` and set your local tunnel target.

```bash
cp .env.example .env
```

Example:

```env
VITE_API_BASE_URL=http://localhost:4000
VITE_TUNNEL_MANAGER_URL=http://localhost:4100
VITE_API_PORTS=4000,4001,4002

REMOTE_TUNNEL_HOST=c03
REMOTE_TUNNEL_USER=
REMOTE_TUNNEL_PORT=4000
REMOTE_TUNNEL_PORTS=4000,4001,4002
REMOTE_TUNNEL_TARGET_HOST=
LOCAL_TUNNEL_BIND=127.0.0.1
TUNNEL_MANAGER_PORT=4100
```

For your command style:

```bash
ssh -L 4000:c03:4000 matbwyler@172.16.46.6
```

Use:

```env
REMOTE_TUNNEL_HOST=c03
REMOTE_TUNNEL_USER=matbwyler@172.16.46.6
REMOTE_TUNNEL_PORT=4000
REMOTE_TUNNEL_TARGET_HOST=
```

Alternatively, split user and gateway:

```env
REMOTE_TUNNEL_HOST=c03
REMOTE_TUNNEL_USER=matbwyler
REMOTE_TUNNEL_GATEWAY=172.16.46.6
REMOTE_TUNNEL_PORT=4000
```

## Automatic Tunnel Manager

`npm run dev` now starts two local processes:

- Vite frontend server
- `tunnel-manager.mjs`, which creates and monitors the SSH tunnel

The manager exposes:

- `GET /status` to report all configured tunnels and API reachability
- `GET /status/:port` to report a single tunnel
- `POST /restart` with optional JSON body `{ "port": 4001 }` to restart one tunnel
- `POST /restart/:port` to restart one tunnel

The dashboard calls these endpoints to show per-port status, switch API view across ports, and restart each tunnel from the UI.

## Manual SSH Tunnel Example (optional)

If MoST-API runs on remote HPC and exposes port `4000` remotely:

```bash
ssh -N -L 4000:127.0.0.1:4000 your_user@your_hpc_host
```

Then run this frontend locally and keep `VITE_API_BASE_URL=http://localhost:4000`.

## Development

```bash
npm run dev
```

## Production Build

```bash
npm run build
npm run preview
```

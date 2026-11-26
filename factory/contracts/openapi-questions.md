# Unspecified API bodies

The API document leaves these complete shapes open for their handler packages.

## Requests

- `POST /system/stop-all`
- `PUT /personnel/replacement-procedure`
- `POST /robots`
- `PATCH /robots/{id}`
- `POST /robots/{id}/configurations`
- `POST /robots/{id}/assignments`
- `POST /robots/{id}/leases`
- `DELETE /robots/{id}/leases/{number}`
- `PATCH /robot-zones/{id}`
- `POST /robot-start-confirmations`
- `POST /unattended-policies`
- `POST /robots/{id}/stop`
- `POST /robots/{id}/release`
- `POST /robots/{id}/diagnostics`
- `POST /robot-start-presses`
- `POST /robot-skills/{id}/qualifications`
- `POST /robot-experiments/{id}/admissions`
- `POST /robots/{id}/maintenance`
- `POST /robots/{id}/reports`
- `POST /robots/{id}/challenges`

## Responses

- `POST /system/stop-all` — default
- `PUT /personnel/replacement-procedure` — default
- `GET /robots` — 200
- `GET /robots/{id}` — 200
- `POST /robots` — default
- `PATCH /robots/{id}` — default
- `GET /robots/{id}/configurations` — 200
- `POST /robots/{id}/configurations` — default
- `GET /robots/{id}/state` — 200
- `POST /robots/{id}/assignments` — default
- `DELETE /robots/{id}/assignments/{aid}` — default
- `GET /robots/{id}/leases` — 200
- `POST /robots/{id}/leases` — default
- `DELETE /robots/{id}/leases/{number}` — default
- `GET /robot-zones` — 200
- `PATCH /robot-zones/{id}` — default
- `POST /robot-start-confirmations` — default
- `GET /unattended-policies` — 200
- `POST /unattended-policies` — default
- `POST /robots/{id}/stop` — 202
- `POST /robots/{id}/release` — default
- `GET /robots/{id}/diagnostics` — 200
- `POST /robots/{id}/diagnostics` — default
- `POST /robot-start-presses` — default
- `GET /robot-skills` — 200
- `GET /robot-skills/{id}` — 200
- `POST /robot-skills/{id}/qualifications` — default
- `POST /robot-experiments/{id}/admissions` — default
- `GET /robots/{id}/maintenance` — 200
- `POST /robots/{id}/maintenance` — default
- `GET /inventory` — 200
- `GET /robot-experiments` — 200
- `GET /robot-experiments/{id}` — 200
- `GET /robot-evidence/{id}` — 200
- `GET /robot-stages` — 200
- `POST /robots/{id}/reports` — default
- `GET /robots/{id}/commands` — 200
- `POST /robots/{id}/challenges` — default

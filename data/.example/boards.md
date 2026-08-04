# ATS / careers-board registry

One row per company: where its board is and whether a stateless run can read it.

| company | market | ats | endpoint | access | volatile | last_verified | notes |
|---------|--------|-----|----------|--------|----------|---------------|-------|
| Northwind Security | Cybersecurity | greenhouse | https://boards.example.com/northwind | json | no | 2026-08-02 |  |
| Aegis Networks | Cybersecurity | lever | https://jobs.example.com/aegis | json | no | 2026-08-02 |  |
| Helios Data | Cybersecurity | ashby | https://jobs.example.com/helios | html | no | 2026-08-01 |  |
| Kestrel Protect | Cybersecurity |  | https://kestrel.example/careers | browser | yes | 2026-07-30 | JS-rendered; needs a browser pass |
| Quaystone Bank | Fintech |  | https://quaystone.example/careers | blocked | no | 2026-07-29 | 403 to scripted requests |

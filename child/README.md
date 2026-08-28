# Duck child worker

The main Duck process remains authoritative. A child accepts only the fixed job names implemented in `src/agent.js`; it cannot run shell commands, change Discord settings, access billing, or choose its clusters.

1. In the private Operator Deck, create a one-time child enrollment token.
2. Drag/copy this `child/` directory onto Ubuntu and run `sudo sh install.sh`. It installs the locked-down service but does not start it before you configure the environment.
3. Put the one-time token in that environment file, start the worker once, then remove the token. Its Ed25519 private identity stays in `/opt/duck-child/child-data`.
4. Install `duck-child.service`, run `systemctl daemon-reload`, then enable and start it.
5. Assign clusters to the worker from the Operator Deck. Unassigned or unhealthy clusters stay on the manager fallback.

Use HTTPS between child and manager. Only localhost development accepts plain HTTP.

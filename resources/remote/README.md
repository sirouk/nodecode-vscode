# nodecode-web-remote

This organism on the tailnet's own https address, for a phone or a laptop that
has no ssh and no loopback port.

Turn it on with `/remote on` — or in the page's `Machines` → `Tailnet access`
panel, when the web cell installed here carries one; a web page without the
panel is served exactly the same, and the command is the whole of the control.
It serves the web cell's page at

    https://<this-machine>.<your-tailnet>.ts.net:8434/web/

and pairs each device that comes through with a code the panel shows. A paired
device keeps a cookie and can be forgotten on its own.

- **It never takes 443.** The mapping is on a port of its own (8434, or the next free one of 8434-8438, unless the
  cell's `https_port` setting says otherwise), so whatever this node already
  serves on its https root keeps working. A path under 443 was tried and does
  not work: `tailscale serve --set-path` strips the prefix, and the page asks
  its gateway for absolute paths.
- **A port already in use is not taken.** If the port it wanted is serving
  something of someone else's, it moves to the next free one and says which in
  the panel; the address it shows is always the port it actually took. An entry
  left behind by a run that died is recognised as its own and taken back.
- **`tailscale serve`, not `funnel`.** Serve is reachable from your tailnet
  only. Funnel would publish this to the internet.
- **Who connected is Tailscale's word, not the client's.** `serve` replaces any
  `tailscale-user-login` a client sends with the one it verified, so the header
  this cell reads cannot be forged from outside. A request with no such header
  never came through the tailnet and is refused.
- **The code is the authorization.** Anyone on the tailnet can reach the
  pairing screen; only a device holding a live code gets in. Each device is
  recorded with the account it paired as, and can be forgotten separately.
- **`rel="noreferrer"` page, no token in the address bar.** The page needs the
  operator token; this cell hands it to the page in one script tag rather than
  in the link, so it never appears in a URL the browser keeps.

## What it needs

1. [Tailscale](https://tailscale.com/download) on this machine, signed in
   (`tailscale up`).
2. MagicDNS and **HTTPS Certificates** on for the tailnet, in the admin
   console under DNS. That one has no command-line switch; the panel links
   straight to it when it is off.

If any of that is missing the panel says which step, and where to take it,
instead of offering a switch that would fail.

## Notes

- The proxy listens on loopback only; the tailnet reaches `serve`, never this.
- Turning it off removes this cell's own https port and nothing else.
- Tailnet access comes back by itself after a restart or a Nodecode update; the
  wish is a file in the home (`web/bridge-on`), and paired devices are kept
  beside it.

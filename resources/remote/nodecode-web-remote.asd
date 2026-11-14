;;;; nodecode-web-remote.asd --- this organism on the tailnet's own https.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; Optional cell, and nothing here is part of the organism core: the body of
;;;; the work is remote.lisp, which puts a loopback proxy behind `tailscale
;;;; serve' and pairs the devices that come through it. It serves on an https
;;;; port of its own and leaves 443 alone.

(defsystem "nodecode-web-remote"
  :description "Reach this organism from the rest of the tailnet over its own https port, pairing each device with a code"
  :license "MIT"
  :version "0.1.0"
  :depends-on ("nodecode" "usocket")
  :components ((:file "cell") (:file "remote")))

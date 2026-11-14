;;;; cell.lisp --- this organism reached from the rest of the tailnet, over https.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The shipped web cell serves the page at loopback only, and that is right:
;;;; the gateway refuses every request whose Host is not loopback, which is what
;;;; stops a rebound name from reaching it. This cell is the one front door for
;;;; the rest of the tailnet, and it adds nothing to the tailnet except an https
;;;; listener: `tailscale serve' terminates TLS on this node's own MagicDNS name
;;;; with a certificate Tailscale obtains and keeps, stamps who connected, and
;;;; proxies to a loopback port this file listens on (remote.lisp).
;;;;
;;;; It serves on an https port of its own -- 8443 unless the setting says
;;;; otherwise -- never on 443, which belongs to whatever else this node serves.
;;;; A path under 443 was measured and rejected: `tailscale serve --set-path'
;;;; strips the prefix before the request arrives, and the page asks its gateway
;;;; for absolute paths (/api/...), which would leave the prefix behind.

(defpackage #:nodecode-web-remote
  (:use #:cl))

(in-package #:nodecode-web-remote)

(nlk:define-peripheral remote :not-running t)

;;; --- what the gateway and the rest of the cell offer --------------------

(defun free-loopback-port ()
  "A port on 127.0.0.1 nothing is listening on: bound and released, as the
gateway picks its own."
  (let ((socket (usocket:socket-listen "127.0.0.1" 0 :reuse-address nil)))
    (unwind-protect (usocket:get-local-port socket)
      (usocket:socket-close socket))))

(defun gateway-port ()
  "The port this gateway listens on."
  (or (ignore-errors nle::*gateway-bound-port*) 0))

(defun gateway-token ()
  "The operator token this gateway answers for."
  (or (ignore-errors nle::*gateway-operator-token*)
      (ignore-errors
       (string-trim '(#\Space #\Tab #\Newline #\Return)
                    (uiop:read-file-string (nlk:home "operator-token"))))
      ""))

(defun json-answer (status object &aux (body (nlk:encode-json-octets object)))
  "OBJECT as JSON with STATUS."
  (list status (list :content-type "application/json" :content-length (length body)) body))

(defun request-octets (env limit &aux (body (getf env :raw-body))
                                        (declared (getf env :content-length)))
  "ENV's body as octets, or NIL when it declares or runs past LIMIT bytes. The
body is read to its end either way, so the connection is left clean."
  (let ((buffer (make-array 65536 :element-type '(unsigned-byte 8)))
        (kept (make-array 0 :element-type '(unsigned-byte 8) :adjustable t :fill-pointer 0))
        (over (and declared (> declared limit))))
    (when body
      (loop with left = (or declared most-positive-fixnum)
            while (plusp left)
            do (let ((got (read-sequence buffer body :end (min left (length buffer)))))
                 (when (zerop got) (return))
                 (decf left got)
                 (unless over
                   (if (> (+ (fill-pointer kept) got) limit)
                       (setf over t)
                       (loop for index below got
                             do (vector-push-extend (aref buffer index) kept (length buffer))))))))
    (and (not over) (coerce kept '(simple-array (unsigned-byte 8) (*))))))

(defun tasks-refused (status code message &rest more)
  "A refusal the page shows: {error: {code, message}}, MORE beside it."
  (let ((object (nlk:json-object "error" (nlk:json-object "code" code "message" message))))
    (loop for (key value) on more by #'cddr do (setf (gethash key object) value))
    (json-answer status object)))

(defun tailscale-binary ()
  "Where tailscale is, or NIL when this machine has none."
  (or (loop for candidate in '("tailscale"
                              "/usr/local/bin/tailscale"
                              "/opt/homebrew/bin/tailscale"
                              "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
                              "C:\\Program Files\\Tailscale\\tailscale.exe"
                              "C:\\Program Files (x86)\\Tailscale\\tailscale.exe")
            when (handler-case (progn (uiop:run-program (list candidate "version") :output :string
                                                       :error-output nil :ignore-error-status t)
                                      t)
                   (error () nil))
              return candidate)
      nil))

(defun tailnet-status ()
  "Tailscale's own view of the tailnet, as it answers --json; NIL when this
machine has no tailscale, or it is not running."
  (let ((binary (tailscale-binary)))
    (when binary
      (handler-case
          (let* ((text (uiop:run-program (list binary "status" "--json")
                                         :output :string :error-output nil :ignore-error-status t))
                 (status (and text (plusp (length text)) (nlk:decode-json text))))
            (and (hash-table-p status) status))
        (error () nil)))))

;;; --- the cell -----------------------------------------------------------

(defun remote-command (args session-id)
  "/remote [status|on|off|code] => what remote access is doing, or a change
  to it. The same acts the page's panel offers, for the shell."
  (declare (ignore session-id))
  (let ((what (string-downcase (string-trim '(#\Space #\Tab) (or args ""))))) (cond
    ((string= what "on")
     (multiple-value-bind (okp why) (bridge-start)
       (if okp (format nil "remote access on: ~a" why)
           (format nil "could not turn it on: ~a" why))))
    ((string= what "off")
     (bridge-stop)
     "remote access off; paired devices are kept")
    ((string= what "code")
     (if (bridge-running-p)
         (format nil "pairing code ~a, good for ~d minutes"
                 (mint-code) (round *bridge-code-seconds* 60))
         "remote access is off; /remote on first"))
    (t
     (if (bridge-running-p)
         (format nil "remote access on at ~a, ~d device~:p paired"
                 (bridge-address) (length (read-devices)))
         "remote access off; /remote on to serve this organism over your tailnet")))))

(nle:define-cell remote
  (:section ("remote access")
    (:guide "the page under Machines, remote access: turn it on, then pair a device with the code it shows")
    ("https_port" :integer :default 8443
     :doc "the https port this cell serves the page on, beside whatever this node already serves on 443"))
  (:command "remote" 'remote-command :description "remote access over your tailnet: status, on, off, code")
  ;; The panel's section reads and acts here; a page with no such cell at this
  ;; path simply does not draw it.
  (:route "/api/remote" (lambda (env) (bridge-route env))))

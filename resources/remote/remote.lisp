;;;; remote.lisp --- this organism from the rest of the tailnet, over https.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The gateway answers at loopback only, and refuses every request whose Host
;;;; is not 127.0.0.1 or localhost -- the guard that keeps a rebound name from
;;;; reaching it. That guard is why a peer cannot open this page over its
;;;; tailnet address, however the bytes arrive.
;;;;
;;;; `tailscale serve' is the one front door that can stand in front of it
;;;; without widening that guard. It terminates TLS on this node's own MagicDNS
;;;; name (https://NAME.ts.net) with a certificate tailscale obtains and keeps
;;;; renewed, so the page is a secure context -- which plain http://100.x is
;;;; not, and clipboard and the rest need. And it hands the backend three facts
;;;; a client cannot forge, because it replaces them on the way through
;;;; whatever the client sent (checked: a forged tailscale-user-login sent from
;;;; another machine arrives as the true one):
;;;;
;;;;   tailscale-user-login   who connected, per the tailnet
;;;;   x-forwarded-for        the tailnet address they connected from
;;;;   x-forwarded-proto      https
;;;;
;;;; So this file listens on loopback behind serve, and changes on the way
;;;; through exactly what the gateway needs to see instead: Host and Origin
;;;; become the loopback authority, so a request that really came from another
;;;; machine satisfies both the rebinding guard and the socket's origin check.
;;;; Everything else -- every byte of the page, the operator token, the socket
;;;; at /gateway -- passes through untouched.
;;;;
;;;; It answers nobody until the operator turns it on, and then only a request
;;;; the tailnet's front door vouched for: serve stamps who connected, and a
;;;; request that never went through it carries no login at all, which is
;;;; refused. Any device signed in to the tailnet may then ask to pair, and the
;;;; code is what admits it -- the machine itself may carry one person's login
;;;; while the phone or laptop carries another of theirs. The device that
;;;; presents the code is given a cookie of its own, records the account it
;;;; paired as, and can be forgotten on its own. The page is handed the
;;;; operator token by one script tag this file serves, so the address bar
;;;; never carries it.
;;;;
;;;; The route here is the operator's alone and takes the operator token like
;;;; every /api route: remote access is not something a page another site
;;;; frames could turn on.

(in-package #:nodecode-web-remote)

;; Parameters, not constants: a cell whose file is reloaded in a running image
;; meets each of these again, and a constant's redefinition stops the file there.
(defparameter *bridge-max-head* 65536
  "The largest request head read, in bytes.")
(defparameter *bridge-max-body* (* 8 1024)
  "The largest body the pairing form answers, in bytes.")
(defparameter *bridge-max-connections* 64
  "The most connections answered at once; the rest are closed.")
(defparameter *bridge-cookie* "nodecode-bridge"
  "What a paired device's cookie is called.")
(defparameter *bridge-https-port* 8434
  "The https port this node serves the page on, beside whatever it already
serves on 443. A port of its own, never the root: the page asks the gateway
for absolute paths (/api/...), and tailscale's --set-path strips the prefix
before they arrive, so a path scope would break the page -- while a second
port is a mapping of its own that leaves the node's 443 exactly as it was.")
(defparameter *bridge-cookie-seconds* (* 30 24 60 60)
  "How long a paired device stays paired, in seconds.")
(defparameter *bridge-port-span* 5
  "How many https ports past the one asked for this cell will look for a free
one before giving up and saying so. The same five ports are what one machine
knocks on to find another: 8434 to 8438.")

(defparameter *bridge-hello-path* "/__tailnet/hello"
  "Who answers here is a nodecode tailnet bridge. Public to the tailnet and no
further: a machine that has never paired with this one can still learn that it
is here, and nothing else.")

(defparameter *bridge-hello-protocol* "nodecode-tailnet/1"
  "The word a probe must hear back: a version of the handshake, not a guess at
a response.")

(defparameter *bridge-peer-cache-seconds* 90
  "How long an answer about the tailnet's other machines is kept before the
tailnet is knocked on again.")
(defparameter *bridge-code-seconds* (* 10 60)
  "How long a pairing code works for, in seconds.")
(defparameter *bridge-script-path* "/__bridge.js"
  "The one file the page asks for that no gateway serves.")
(defparameter *bridge-page-max* (* 4 1024 1024)
  "The largest page this file holds to put one tag in, in bytes.")
(defparameter *bridge-token-key* "nodecode-web-token"
  "The session storage key the page keeps its operator token under (app.js).")

(defparameter +code-alphabet+ "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  "The pairing code's alphabet: no 0/O or 1/I, so a code read aloud is a code.")

(defvar *bridge* nil
  "The bridge as it stands: :server, :port, :thread, :login, :name, :code,
:code-expires. NIL while remote access is off.")
(defvar *bridge-lock* (sb-thread:make-mutex :name "web bridge"))
(defvar *bridge-live* 0
  "How many connections are being answered right now.")
(defvar *bridge-count-lock* (sb-thread:make-mutex :name "web bridge count"))
(defvar *bridge-refusal* nil
  "The last reason a device was turned away, for the panel to show.")
(defvar *bridge-error* nil
  "What went wrong answering the last connection, if anything did.")

(defvar *bridge-peer-cache* nil
  "The last answer about the tailnet's other machines: (time . machines).")

;;; --- whose tailnet this is ----------------------------------------------

(defun tailnet-login ()
  "The login of the tailnet user this node belongs to, or NIL."
  (let* ((status (tailnet-status))
         (self (and status (gethash "Self" status)))
         (users (and status (gethash "User" status)))
         (id (and (hash-table-p self) (gethash "UserID" self)))
         (user (and (hash-table-p users) id (gethash (princ-to-string id) users))))
    (and (hash-table-p user) (nlk:json-value user :text "LoginName"))))

(defun tailnet-name ()
  "This node's own MagicDNS name, without the trailing dot, or NIL."
  (let* ((status (tailnet-status))
         (self (and status (gethash "Self" status)))
         (dns (and (hash-table-p self) (nlk:json-value self :text "DNSName"))))
    (and dns (plusp (length dns)) (string-right-trim "." dns))))

(defun bridge-https-port ()
  "The https port to serve on: the cell's setting when it has one, else 8443.
Never 443, which is not this cell's to take."
  ;; The declared name is `https_port'; the key SETTING reads is the wire
  ;; symbol, :HTTPS-PORT. Reading the declared spelling answers NIL, silently.
  (let ((chosen (ignore-errors (setting :https-port))))
    (if (and (integerp chosen) (plusp chosen) (/= chosen 443))
        chosen
        *bridge-https-port*)))

(defun host-of (dns-name)
  "The machine part of a MagicDNS name: rt50.tail77f45e.ts.net. => rt50"
  (let ((dot (position #\. dns-name)))
    (if dot (subseq dns-name 0 dot) dns-name)))

(defun hello-json ()
  "What this bridge says when another machine knocks."
  (nlk:json-object
   "protocol" *bridge-hello-protocol*
   "name" (host-of (or (tailnet-name) ""))
   "host" (or (tailnet-name) :null)
   "version" "0.1.0"
   "port" (or (getf *bridge* :https-port) (bridge-https-port))
   "address" (or (bridge-address) :null)))

(defun probe-peer (host)
  "Does HOST answer as a nodecode tailnet bridge? Its hello, or NIL. Every port
of the span is tried, so a machine that took the next one is still found."
  (let ((first (bridge-https-port)))
    (loop for port from first below (+ first *bridge-port-span*)
          do (let ((url (format nil "https://~a:~d~a" host port *bridge-hello-path*)))
               (handler-case
                   (let ((parsed (ignore-errors
                                  (nlk:decode-json
                                   (dexador:get url :connect-timeout 1.2 :read-timeout 2
                                                    :force-string t)))))
                     (when (and (hash-table-p parsed)
                                (equal (nlk:json-value parsed :text "protocol") *bridge-hello-protocol*))
                       (return (nlk:json-object
                                "name" (or (nlk:json-value parsed :text "name") (host-of host))
                                "host" (or (nlk:json-value parsed :text "host") host)
                                "address" (or (nlk:json-value parsed :text "address") :null)
                                "port" (or (nlk:json-value parsed :integer "port") port)
                                "version" (or (nlk:json-value parsed :text "version") :null)))))
                 (error () nil))))))

(defun online-peers ()
  "The tailnet's other machines that are up right now, by MagicDNS name."
  (let* ((status (tailnet-status))
         (peers (and status (gethash "Peer" status)))
         (names '()))
    (when (hash-table-p peers)
      (maphash (lambda (id peer)
                 (declare (ignore id))
                 (when (and (hash-table-p peer) (nlk:json-value peer :boolean "Online"))
                   (let ((dns (nlk:json-value peer :text "DNSName")))
                     (when dns (push (string-right-trim "." dns) names)))))
               peers))
    names))

(defun tailnet-machines (&key refresh)
  "Every machine on this tailnet that is serving a tailnet bridge, this one
first. Cached: knocking on every peer costs a request each, not a scan."
  (let ((kept *bridge-peer-cache*))
    (when (and (not refresh) kept
               (< (- (get-universal-time) (car kept)) *bridge-peer-cache-seconds*))
      (return-from tailnet-machines (cdr kept)))
    (let* ((hosts (online-peers))
           (found (make-array (length hosts) :initial-element nil))
           (threads (loop for host in hosts for at from 0
                          collect (let ((here at) (peer host))
                                    (sb-thread:make-thread
                                     (lambda () (setf (aref found here) (probe-peer peer)))
                                     :name "tailnet probe")))))
      (dolist (thread threads)
        (ignore-errors (sb-thread:join-thread thread :timeout 8)))
      (let ((machines (loop for machine across found when machine collect machine)))
        ;; This machine answers for itself: it is a machine with access on, and
        ;; the one the panel is being read from.
        (when (bridge-running-p)
          (let ((here (ignore-errors (tailnet-name))))
            (when here
              (push (nlk:json-object
                     "name" (host-of here) "host" (string-right-trim "." here)
                     "address" (or (bridge-address) :null)
                     "port" (getf *bridge* :https-port) "version" "0.1.0")
                    machines))))
        (setf *bridge-peer-cache* (cons (get-universal-time) machines))
        machines))))

(defun bridge-address ()
  "The https address this bridge answers at, or NIL when this machine is not
on a tailnet that has HTTPS. A running bridge answers at the port it took,
which is the one asked for unless that was someone else's."
  (let ((name (tailnet-name)))
    (and name (format nil "https://~a:~d/web/" name
                      (or (getf *bridge* :https-port) (bridge-https-port))))))

;;; --- paired devices -----------------------------------------------------

(defun devices-path ()
  "Where the paired devices are kept, beside the page's other state."
  (nlk:home "web/bridge-devices.json"))

(defun read-devices ()
  "The paired devices, oldest first."
  (let* ((path (devices-path))
         (kept (and (probe-file path) (ignore-errors (nlk:decode-json (uiop:read-file-string path))))))
    (or (nlk:json-value kept :array "devices") #())))

(defun keep-devices (devices)
  "Write DEVICES down."
  (nlk:write-file-atomically (devices-path)
                             (nlk:encode-json-object (nlk:json-object "devices" devices))))

(defun bridge-intent-path ()
  "A file whose presence says remote access was left on: the next boot starts
it again. It lives in the home, not in a cell folder, so an update that brings
a new generation along does not take the wish with it."
  (nlk:home "web/bridge-on"))

(defun bridge-intended-p ()
  "Was remote access on when this organism last ran?"
  (and (probe-file (bridge-intent-path)) t))

(defun keep-intent (on)
  "Write down that remote access is ON, or forget it."
  (let ((path (bridge-intent-path)))
    (cond (on (ensure-directories-exist path)
              (with-open-file (out path :direction :output :if-exists :supersede)
                (write-string "on" out)))
          (t (ignore-errors (delete-file path))))))

(defun random-bytes (count)
  "COUNT bytes from the kernel's own source of them."
  (let ((buffer (make-array count :element-type '(unsigned-byte 8))))
    (with-open-file (source "/dev/urandom" :element-type '(unsigned-byte 8))
      (read-sequence buffer source))
    buffer))

(defun random-hex (count)
  "COUNT random bytes as 2*COUNT hexadecimal characters."
  (let ((text (make-string (* 2 count))))
    (loop for byte across (random-bytes count)
          for at from 0 by 2
          do (setf (char text at) (digit-char (ash byte -4) 16)
                   (char text (1+ at)) (digit-char (logand byte 15) 16)))
    text))

(defun new-code ()
  "A pairing code, XXXX-XXXX, in an alphabet that has no look-alikes."
  (let ((code (make-string 9 :initial-element #\-)))
    (loop for byte across (random-bytes 8)
          for at from 0
          do (setf (char code (if (< at 4) at (1+ at)))
                   (char +code-alphabet+ (mod byte 32))))
    code))

(defun normalize-code (text)
  "TEXT as a code is compared: its letters and digits only, upper case."
  (string-upcase (remove-if-not #'alphanumericp (or text ""))))

(defun code-live-p ()
  "Does a pairing code stand, and has it time left?"
  (let ((until (getf *bridge* :code-expires)))
    (and (getf *bridge* :code) until (> until (get-universal-time)))))

(defun mint-code ()
  "A fresh pairing code, which spends whatever code stood before it."
  (sb-thread:with-mutex (*bridge-lock*)
    (let ((code (new-code)))
      (setf (getf *bridge* :code) code
            (getf *bridge* :code-expires) (+ (get-universal-time) *bridge-code-seconds*))
      code)))

(defun add-device (login name)
  "Pair a device of LOGIN, called NAME, and answer the token it keeps."
  (let* ((token (random-hex 32))
         (devices (read-devices))
         (kept (make-array (1+ (length devices)) :initial-element nil)))
    (loop for device across devices
          for at from 0
          do (setf (aref kept at) device))
    (setf (aref kept (length devices))
          (nlk:json-object "token" token
                           "login" (or login "")
                           "name" (or name "a device")
                           "created" (get-universal-time)))
    (keep-devices kept)
    token))

(defun forget-device (index)
  "Unpair the device at INDEX."
  (let ((devices (read-devices)))
    (when (and (integerp index) (>= index 0) (< index (length devices)))
      (let ((kept '()))
        (loop for device across devices
              for at from 0
              unless (= at index)
                do (push device kept))
        (keep-devices (coerce (nreverse kept) 'simple-vector))))))

(defun device-for (token)
  "The paired device that keeps TOKEN, or NIL."
  (when (and token (plusp (length token)))
    (loop for device across (read-devices)
          when (string= token (or (nlk:json-value device :text "token") ""))
            return device)))

;;; --- reading and writing the wire --------------------------------------

(defun octets-of (text)
  "TEXT as UTF-8 octets."
  (sb-ext:string-to-octets text :external-format :utf-8))

(defun socket-fd (socket)
  "SOCKET's file descriptor."
  (sb-bsd-sockets:socket-file-descriptor socket))

(defun fd-read (fd buffer)
  "The octets read from FD into BUFFER, or NIL at end of file. The buffer is
pinned across the call: this image's collector moves objects, and the kernel
writes where the vector was, not where it went."
  (multiple-value-bind (count errno)
      (sb-sys:with-pinned-objects (buffer)
        (sb-unix:unix-read fd (sb-sys:vector-sap buffer) (length buffer)))
    (declare (ignore errno))
    (and count (plusp count) count)))

(defun fd-write (fd octets &key (start 0) (end (length octets)))
  "OCTETS' START..END written to FD => T when all of it went."
  (loop with at = start
        while (< at end)
        do (multiple-value-bind (count errno)
               (sb-sys:with-pinned-objects (octets)
                 (sb-unix:unix-write fd (sb-sys:vector-sap octets) at (- end at)))
             (declare (ignore errno))
             (if (and count (plusp count))
                 (incf at count)
                 (return nil)))
        finally (return t)))

(defun head-end (octets)
  "Where OCTETS' head stops: the index just past its blank line, or NIL."
  (loop for at from 0 to (- (length octets) 4)
        when (and (= 13 (aref octets at)) (= 10 (aref octets (1+ at)))
                  (= 13 (aref octets (+ at 2))) (= 10 (aref octets (+ at 3))))
          return (+ at 4)))

(defun read-head (fd)
  "The request's head on FD, and the octets that came past it => (values HEAD
LEFT); NIL when nothing arrived or the head ran past its ceiling."
  (let ((buffer (make-array 8192 :element-type '(unsigned-byte 8)))
        (kept (make-array 1024 :element-type '(unsigned-byte 8) :adjustable t :fill-pointer 0)))
    (loop
      (let ((count (fd-read fd buffer)))
        (unless count (return nil))
        (loop for at below count
              do (vector-push-extend (aref buffer at) kept))
        (when (> (fill-pointer kept) *bridge-max-head*) (return nil))
        (let ((stop (head-end kept)))
          (when stop (return (values (subseq kept 0 stop) (subseq kept stop)))))))))

(defun text-of (octets)
  "OCTETS as text, for a request line and its headers."
  (sb-ext:octets-to-string octets :external-format :latin-1))

(defun parse-head (octets)
  "OCTETS' request line and headers => (values METHOD TARGET HEADERS), the
headers an alist of lower-case name and value in the order they arrived."
  (let* ((lines (uiop:split-string (text-of octets) :separator '(#\Return #\Newline)))
         (request (string-trim '(#\Space #\Tab #\Return) (or (first lines) "")))
         (parts (uiop:split-string request :separator '(#\Space)))
         (headers '()))
    (dolist (line (rest lines))
      (let ((colon (position #\: line)))
        (when colon
          (push (cons (string-downcase (subseq line 0 colon))
                      (string-trim '(#\Space #\Tab #\Return) (subseq line (1+ colon))))
                headers))))
    (values (string-upcase (or (first parts) "GET"))
            (or (second parts) "/")
            (nreverse headers))))

(defun header (headers name)
  "The first HEADERS entry called NAME, or NIL."
  (cdr (assoc name headers :test #'string=)))

(defun cookies-of (headers)
  "The request's cookies as an alist of name and value."
  (let ((all '()))
    (dolist (entry headers)
      (when (string= (car entry) "cookie")
        (dolist (part (uiop:split-string (cdr entry) :separator '(#\;)))
          (let ((equals (position #\= part)))
            (when equals
              (push (cons (string-trim '(#\Space) (subseq part 0 equals))
                          (string-trim '(#\Space #\Tab) (subseq part (1+ equals))))
                    all))))))
    all))

(defun cookie-value (headers name)
  "The cookie called NAME HEADERS carry, or NIL."
  (cdr (assoc name (cookies-of headers) :test #'string=)))

(defun answer-bytes (fd status reason headers body &key (method "GET"))
  "BODY, octets, answered to FD with STATUS and HEADERS (an alist)."
  (let ((head (with-output-to-string (out)
                (format out "HTTP/1.1 ~d ~a~c~c" status reason #\Return #\Newline)
                (format out "connection: close~c~c" #\Return #\Newline)
                (format out "content-length: ~d~c~c" (length body) #\Return #\Newline)
                (loop for (name . value) in headers
                      do (format out "~a: ~a~c~c" name value #\Return #\Newline))
                (format out "~c~c" #\Return #\Newline))))
    (fd-write fd (octets-of head))
    (unless (string-equal method "HEAD")
      (fd-write fd body))))

(defun answer-text (fd status reason type text &key (method "GET") (headers '()))
  "TEXT answered to FD with STATUS and its media TYPE."
  (answer-bytes fd status reason
                (append headers (list (cons "content-type" type)
                                      (cons "cache-control" "no-store")))
                (octets-of text) :method method))

(defun redirect (fd where)
  "Send the browser to WHERE, at this same origin."
  (answer-text fd 303 "See Other" "text/plain; charset=utf-8" (format nil "~a" where)
               :headers (list (cons "location" where))))

;;; --- what a device is shown before it is paired -------------------------

(defparameter +pair-style+
  (concatenate 'string
               "html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;"
               "place-items:center;background:#111;color:#e8e8e8;"
               "font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}"
               "main{width:min(24rem,90vw)}h1{margin:0 0 .25rem;font-size:1.25rem;font-weight:600}"
               "p{margin:.75rem 0;color:#a8a8a8}h1+p{margin-top:.5rem}"
               "form{display:flex;gap:.5rem;margin:1.25rem 0}"
               "input{flex:1;min-width:0;padding:.6rem .7rem;border-radius:.4rem;"
               "border:1px solid #333;background:#1a1a1a;color:inherit;font:inherit;"
               "letter-spacing:.15em;text-transform:uppercase}"
               "button{padding:.6rem .9rem;border-radius:.4rem;border:0;background:#4a8cff;"
               "color:#fff;font:inherit;font-weight:600}"
               ".why{color:#ff9b9b}.why:empty{display:none}")
  "The pairing page's one style block.")

(defun html-escape (text)
  "TEXT safe in HTML."
  (with-output-to-string (out)
    (loop for char across text
          do (case char
               (#\& (write-string "&amp;" out))
               (#\< (write-string "&lt;" out))
               (#\> (write-string "&gt;" out))
               (#\" (write-string "&quot;" out))
               (t (write-char char out))))))

(defun pair-page (login message)
  "The page a device sees before it is paired: whose tailnet this is, and the
one field it asks for."
  (format nil "<!doctype html><html lang=en><head><meta charset=utf-8>~
               <meta name=viewport content='width=device-width,initial-scale=1'>~
               <meta name=color-scheme content=dark><title>Pair this device</title>~
               <style>~a</style></head><body><main><h1>Pair this device</h1>~
               <p>This machine answers the devices of its own tailnet, once each.~
               You are signed in as <b>~a</b>.</p>~
               <p>Type the code it shows under Machines.</p>~
               <form method=post action=/pair>~
               <input name=code autocomplete=one-time-code autofocus required placeholder=XXXX-XXXX>~
               <button type=submit>Pair</button></form>~
               <p class=why>~a</p></main></body></html>"
          +pair-style+ (html-escape (or login "")) (html-escape message)))

(defun pair-headers ()
  "What the pairing page is sent with: its own style, nothing else, and a form
that only goes back here."
  (list (cons "content-type" "text/html; charset=utf-8")
        (cons "cache-control" "no-store")
        (cons "content-security-policy"
              "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
        (cons "x-content-type-options" "nosniff")
        (cons "referrer-policy" "no-referrer")))

;;; --- the operator token, handed to the page -----------------------------

(defun json-string (text)
  "TEXT as a JavaScript string literal."
  (with-output-to-string (out)
    (write-char #\" out)
    (loop for char across text
          do (case char
               (#\" (write-string "\\\"" out))
               (#\\ (write-string "\\\\" out))
               (#\Newline (write-string "\\n" out))
               (t (if (< (char-code char) 32)
                      (format out "\\u~4,'0x" (char-code char))
                      (write-char char out)))))
    (write-char #\" out)))

(defun token-script ()
  "The script the page is handed its operator token by: one line, nothing but
the token in it, and it goes where the page keeps it anyway -- the tab's own
session storage. The address bar never carries it."
  (format nil "try{sessionStorage.setItem(~a,~a)}catch(e){}~%"
          (json-string *bridge-token-key*) (json-string (gateway-token))))

(defun page-tag ()
  "The one tag a page this bridge serves carries."
  (format nil "<script src=~s></script>" *bridge-script-path*))

(defun with-token (html)
  "HTML with the token's tag in its head, or at its front when it has no head."
  (let ((at (search "<head>" html :test #'char-equal)))
    (if at
        (concatenate 'string (subseq html 0 (+ at 6)) (page-tag) (subseq html (+ at 6)))
        (concatenate 'string (page-tag) html))))

;;; --- the gateway behind it ----------------------------------------------

(defun open-upstream (&optional (port (gateway-port)))
  "A connection to this gateway's own loopback port, or NIL."
  (when (and port (plusp port))
    (let ((socket (make-instance 'sb-bsd-sockets:inet-socket :type :stream :protocol :tcp)))
      (handler-case
          (progn
            (sb-bsd-sockets:socket-connect socket
                                           (sb-bsd-sockets:make-inet-address "127.0.0.1")
                                           port)
            socket)
        (error () (ignore-errors (sb-bsd-sockets:socket-close socket)) nil)))))

(defun loopback-authority ()
  "What the gateway answers to: its own loopback host and port."
  (format nil "127.0.0.1:~d" (gateway-port)))

(defparameter +tailnet-only-headers+
  '("tailscale-user-login" "tailscale-user-name" "tailscale-user-profile-pic"
    "tailscale-headers-info" "tailscale-app-capabilities" "tailscale-cap-version"
    "x-forwarded-for" "x-forwarded-host" "x-forwarded-proto" "x-real-ip")
  "What only the front door said, and the gateway has no business seeing.")

(defun forwarded-head (method target headers close)
  "The request line and headers to send upstream: Host and Origin the loopback
authority, and nothing that only the front door planted."
  (with-output-to-string (out)
    (format out "~a ~a HTTP/1.1~c~c" method target #\Return #\Newline)
    (let ((connection nil))
      (dolist (entry headers)
        (let ((name (car entry)) (value (cdr entry)))
          (cond
            ((member name +tailnet-only-headers+ :test #'string=))
            ((string= name "host")
             (format out "host: ~a~c~c" (loopback-authority) #\Return #\Newline))
            ((string= name "origin")
             (format out "origin: http://~a~c~c" (loopback-authority) #\Return #\Newline))
            ((string= name "connection")
             (setf connection t)
             (format out "connection: ~a~c~c" (if close "close" value) #\Return #\Newline))
            (t (format out "~a: ~a~c~c" name value #\Return #\Newline)))))
      (unless connection
        (format out "connection: close~c~c" #\Return #\Newline))
      (format out "~c~c" #\Return #\Newline))))

(defun pump (from to)
  "Everything FROM says, to TO, until it says no more."
  (let ((buffer (make-array 65536 :element-type '(unsigned-byte 8))))
    (handler-case
        (loop for count = (fd-read from buffer)
              while count
              do (unless (fd-write to buffer :end count) (return)))
      (error () nil))))

(defun shut (socket)
  "Tell the far end of SOCKET that nothing more is coming."
  (ignore-errors (sb-bsd-sockets:socket-shutdown socket :direction :io)))

(defun forward (client method target headers body)
  "Send the request upstream and its answer back: a byte-for-byte pipe once the
head is rewritten, so the page, its files and the socket at /gateway pass
through as they are. One request to a connection: the answer is asked to close,
which the gateway honors, and then both ends go."
  (let ((upstream (open-upstream))
        (here (socket-fd client)))
    (unless upstream
      (return-from forward
        (answer-text here 502 "Bad Gateway" "text/plain; charset=utf-8"
                     "the gateway this bridge stands in front of is not answering")))
    (unwind-protect
         (let* ((out (socket-fd upstream))
                (upgrade (header headers "upgrade"))
                (close (null upgrade)))
           (unless (fd-write out (octets-of (forwarded-head method target headers close)))
             (return-from forward nil))
           (when (plusp (length body))
             (unless (fd-write out body) (return-from forward nil)))
           (if upgrade
               ;; A socket is open both ways for as long as either says
               ;; something: one direction is listened to here, the other in
               ;; a thread of its own.
               (let ((back (sb-thread:make-thread
                            (lambda () (pump here out) (shut client))
                            :name "web bridge request")))
                 (pump out here)
                 (shut client)
                 (ignore-errors (sb-thread:join-thread back :timeout 60)))
               ;; One request, one answer: the body came with it, already read,
               ;; and the answer is then carried back to its end.
               (progn
                 (pump out here)
                 (shut client))))
      (ignore-errors (sb-bsd-sockets:socket-close upstream)))))

(defun read-all (fd)
  "Everything FD says, up to the page ceiling => octets, or NIL past it."
  (let ((buffer (make-array 65536 :element-type '(unsigned-byte 8)))
        (kept (make-array 1024 :element-type '(unsigned-byte 8) :adjustable t :fill-pointer 0)))
    (handler-case
        (loop for count = (fd-read fd buffer)
              while count
              do (loop for at below count do (vector-push-extend (aref buffer at) kept))
                 (when (> (fill-pointer kept) *bridge-page-max*) (return-from read-all nil)))
      (error () nil))
    (subseq kept 0 (fill-pointer kept))))

(defun fetch-page (target)
  "The page at TARGET as the gateway serves it => octets, or NIL."
  (let ((socket (open-upstream)))
    (when socket
      (unwind-protect
           (let ((out (socket-fd socket)))
             (when (fd-write out (octets-of (format nil "GET ~a HTTP/1.1~c~chost: ~a~c~cconnection: close~c~c~c~c"
                                                   target #\Return #\Newline (loopback-authority)
                                                   #\Return #\Newline
                                                   #\Return #\Newline #\Return #\Newline)))
               (read-all out)))
        (ignore-errors (sb-bsd-sockets:socket-close socket))))))

(defun served-page (client method target headers)
  "TARGET from the gateway with the token's tag in it; and when it cannot be
held to be changed, the gateway's own answer, as it came."
  (let ((raw (fetch-page target)))
    (if (null raw)
        (forward client method target headers (make-array 0 :element-type '(unsigned-byte 8)))
        (let* ((stop (head-end raw))
               (head (and stop (text-of (subseq raw 0 stop))))
               (body (and stop (subseq raw stop))))
          (if (and head (search "text/html" head :test #'char-equal)
                   (eql 200 (ignore-errors
                              (parse-integer head :start 9 :end 12 :junk-allowed t))))
              (answer-bytes (socket-fd client) 200 "OK"
                            (list (cons "content-type" "text/html; charset=utf-8")
                                  (cons "cache-control" "no-store")
                                  (cons "content-security-policy"
                                        "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
                                  (cons "x-content-type-options" "nosniff")
                                  (cons "referrer-policy" "no-referrer"))
                            (octets-of (with-token (sb-ext:octets-to-string body :external-format :utf-8)))
                            :method method)
              (forward client method target headers (make-array 0 :element-type '(unsigned-byte 8))))))))

;;; --- the door -----------------------------------------------------------

(defun paired-cookie (headers)
  "The device this request is from, or NIL."
  (device-for (cookie-value headers *bridge-cookie*)))

(defun url-decode (text)
  "TEXT with its %XX escapes and + signs read back."
  (with-output-to-string (out)
    (loop with at = 0 with length = (length text)
          while (< at length)
          do (let ((char (char text at)))
               (cond ((char= char #\+)
                      (write-char #\Space out)
                      (incf at))
                     ((and (char= char #\%) (< (+ at 2) length))
                      (let ((code (ignore-errors (parse-integer text :start (1+ at) :end (+ at 3) :radix 16))))
                        (if code
                            (progn (write-char (code-char code) out) (incf at 3))
                            (progn (write-char char out) (incf at)))))
                     (t (write-char char out) (incf at)))))))

(defun form-field (body name)
  "BODY, a url-encoded form, read for NAME."
  (dolist (part (uiop:split-string (or body "") :separator '(#\&)))
    (let ((equals (position #\= part)))
      (when equals
        (when (string= (url-decode (subseq part 0 equals)) name)
          (return (url-decode (subseq part (1+ equals)))))))))

(defun read-body (fd left declared)
  "The body of the request on FD: what came past the head, then DECLARED bytes."
  (let ((kept (make-array (max declared (length left) 16) :element-type '(unsigned-byte 8)
                          :adjustable t :fill-pointer 0))
        (buffer (make-array 8192 :element-type '(unsigned-byte 8))))
    (loop for octet across left do (vector-push-extend octet kept))
    (loop while (< (fill-pointer kept) declared)
          do (let ((count (fd-read fd buffer)))
               (unless count (return))
               (loop for at below count
                     while (< (fill-pointer kept) declared)
                     do (vector-push-extend (aref buffer at) kept))))
    (subseq kept 0 (fill-pointer kept))))

(defun request-body (fd left headers)
  "The body of the request whose head gave HEADS, LEFT being what came past the
head: all of it, read now. A proxy in front will not finish its stream while
bytes it means to send are still unread on this side, so the body is taken
before any answer goes back -- even one that ignores it."
  (let ((declared (or (ignore-errors
                        (parse-integer (or (header headers "content-length") "0")))
                      0)))
    (cond ((minusp declared) (subseq left 0 (min (length left) 0)))
          ((> declared *bridge-max-body*) :too-big)
          ((<= declared (length left)) (subseq left 0 declared))
          (t (read-body fd left declared)))))

(defun short-device-name (user-agent)
  "What to call the device a USER-AGENT speaks for."
  (cond ((null user-agent) "a device")
        ((search "iPhone" user-agent) "an iPhone")
        ((search "iPad" user-agent) "an iPad")
        ((search "Android" user-agent) "an Android")
        ((search "Macintosh" user-agent) "a Mac")
        ((search "Windows" user-agent) "a PC")
        ((search "Linux" user-agent) "a Linux machine")
        (t (subseq user-agent 0 (min 40 (length user-agent))))))

(defun redeem-code (code login name)
  "CODE as read, for LOGIN: the device token it mints, and the code spent."
  (sb-thread:with-mutex (*bridge-lock*)
    (when (and (code-live-p)
               (string= (normalize-code code) (normalize-code (getf *bridge* :code))))
      (setf (getf *bridge* :code) nil
            (getf *bridge* :code-expires) nil)
      (add-device login (short-device-name name)))))

(defun pairing-answer (client headers)
  "The pairing form, answered."
  (answer-bytes (socket-fd client) 200 "OK" (pair-headers)
                (octets-of (pair-page (header headers "tailscale-user-login") ""))))

(defun pair (client headers body)
  "A posted pairing code: pair the device that presented it, or say why not."
  (let* ((fd (socket-fd client))
         (text (sb-ext:octets-to-string body :external-format :utf-8))
         (login (header headers "tailscale-user-login"))
         (token (redeem-code (form-field text "code") login
                             (header headers "user-agent"))))
    (if token
        (answer-bytes fd 303 "See Other"
                      (list (cons "location" "/web/")
                            (cons "set-cookie"
                                  (format nil "~a=~a; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=~d"
                                          *bridge-cookie* token *bridge-cookie-seconds*))
                            (cons "content-type" "text/plain; charset=utf-8"))
                      (octets-of "/web/"))
        (answer-bytes fd 403 "Forbidden" (pair-headers)
                      (octets-of (pair-page login
                                            "That code is not the one this machine is showing just now."))))))

(defun refuse (fd status reason message)
  "Say no, and why."
  (answer-text fd status reason "text/plain; charset=utf-8" message))

(defun bridge-serve-request (client)
  "Answer one request: the pairing form, the token's script, the page, or
whatever else the gateway makes of it."
  (let ((fd (socket-fd client)))
    (multiple-value-bind (head left) (read-head fd)
      (unless head
        (return-from bridge-serve-request nil))
      (multiple-value-bind (method target headers) (parse-head head)
        (let* ((question (position #\? target))
               (path (if question (subseq target 0 question) target))
               (body (request-body fd left headers))
               (login (header headers "tailscale-user-login")))
          ;; A refusal is news only until the next request that arrives the way
          ;; it should: the panel is not a log, and one old line reads as a fault.
          (when (and login (plusp (length login)))
            (setf *bridge-refusal* nil))
          (cond
            ((eq body :too-big)
             (refuse fd 413 "Payload Too Large" "over the request ceiling"))
            ;; Only the front door can name anyone: no header at all is a
            ;; request that never came through the tailnet.
            ((or (null login) (string= login ""))
             (setf *bridge-refusal* "a request that did not come through the tailnet")
             (refuse fd 403 "Forbidden" "this address answers through the tailnet only"))
            ((string= path "/pair")
             (if (string= method "POST")
                 (pair client headers body)
                 (pairing-answer client headers)))
            ;; Any machine may knock, and a machine that has never paired with
            ;; this one may still learn that it is here. Nothing else is said.
            ((string= path *bridge-hello-path*)
             (answer-text fd 200 "OK" "application/json; charset=utf-8"
                          (nlk:encode-json-object (hello-json))))
            ((null (paired-cookie headers))
             (redirect fd "/pair"))
            ((string= path *bridge-script-path*)
             (answer-bytes fd 200 "OK"
                           (list (cons "content-type" "text/javascript; charset=utf-8")
                                 (cons "cache-control" "no-store"))
                           (octets-of (token-script)) :method method))
            ((string= path "/")
             (redirect fd "/web/"))
            ((member path '("/web/" "/web" "/web/index.html") :test #'string=)
             (served-page client method target headers))
            (t (forward client method target headers body))))))))

(defun bridge-serve-connection (client)
  "Answer one connection, then let it go -- and keep what went wrong, if
anything did, where the panel can show it."
  (unwind-protect
       (handler-case (bridge-serve-request client)
         (error (condition) (setf *bridge-error* (princ-to-string condition))))
    (ignore-errors (sb-bsd-sockets:socket-close client))))

;;; --- switching it on ----------------------------------------------------

(defun bridge-listener (port)
  "A socket listening on 127.0.0.1 at PORT -- loopback only: what another
machine reaches is serve's own https listener, never this."
  (let ((socket (make-instance 'sb-bsd-sockets:inet-socket :type :stream :protocol :tcp)))
    (sb-bsd-sockets:socket-bind socket (sb-bsd-sockets:make-inet-address "127.0.0.1") port)
    (sb-bsd-sockets:socket-listen socket 32)
    socket))

(defun bridge-count (step)
  "Count one connection on STEP, and answer how many are on now."
  (sb-thread:with-mutex (*bridge-count-lock*)
    (incf *bridge-live* step)))

(defun bridge-accept-loop (server)
  "Answer connections until SERVER is closed."
  (handler-case
      (loop
        (let ((client (sb-bsd-sockets:socket-accept server)))
          (if (> (bridge-count 1) *bridge-max-connections*)
              (progn
                (bridge-count -1)
                (ignore-errors (sb-bsd-sockets:socket-close client)))
              (sb-thread:make-thread
               (lambda ()
                 (unwind-protect (bridge-serve-connection client)
                   (bridge-count -1)))
               :name "web bridge connection"))))
    (error () nil)))

(defun run-tailscale (&rest arguments)
  "Tailscale with ARGUMENTS => (values OUTPUT OKP)."
  (let ((binary (tailscale-binary)))
    (if (null binary)
        (values "this machine has no tailscale" nil)
        (handler-case
            (multiple-value-bind (output error code)
                (uiop:run-program (cons binary arguments)
                                  :output :string :error-output :string :ignore-error-status t)
              (declare (ignore output))
              (let ((why (string-trim '(#\Space #\Newline #\Return) (or error ""))))
                (values (if (plusp (length why)) why "ok") (eql 0 code))))
          (error (condition) (values (princ-to-string condition) nil))))))

(defun tailscale-output (&rest arguments)
  "Tailscale with ARGUMENTS => (values STDOUT OKP). run-tailscale answers
what went wrong instead, which is what a caller that only needs to know
whether it worked wants; this is for the ones that read what it said."
  (let ((binary (tailscale-binary)))
    (if (null binary)
        (values "" nil)
        (handler-case
            (multiple-value-bind (output error code)
                (uiop:run-program (cons binary arguments)
                                  :output :string :error-output :string :ignore-error-status t)
              (declare (ignore error))
              (values (or output "") (eql 0 code)))
          (error () (values "" nil))))))

(defun served-target-at (port)
  "What the node already serves at https PORT: the proxy target, :other for a
handler whose target is a file or a text, or NIL for a port with no config."
  (multiple-value-bind (output okp)
      (tailscale-output "serve" "status" "--json")
    (when okp
      (let* ((status (ignore-errors (nlk:decode-json output)))
             (web (and (hash-table-p status) (gethash "Web" status)))
             (suffix (format nil ":~d" port))
             (found nil))
        (when (hash-table-p web)
          (maphash (lambda (host handlers)
                     (when (and (null found)
                                (>= (length host) (length suffix))
                                (string= suffix host :start2 (- (length host) (length suffix))))
                       (let* ((table (and (hash-table-p handlers) (gethash "Handlers" handlers)))
                              (root (and (hash-table-p table) (gethash "/" table))))
                         (setf found (if (hash-table-p root)
                                         (or (nlk:json-value root :text "Proxy") :other)
                                         :other)))))
                   web))
        found))))

(defun loopback-target-p (target)
  "Is TARGET one of this cell's own: a plain http proxy to loopback?"
  (and (stringp target)
       (uiop:string-prefix-p "http://127.0.0.1:" target)
       (every #'digit-char-p (subseq target (length "http://127.0.0.1:")))))

(defun listening-p (port)
  "Is something accepting connections on loopback at PORT?"
  (handler-case
      (let ((socket (make-instance 'sb-bsd-sockets:inet-socket :type :stream :protocol :tcp)))
        (unwind-protect
             (progn (sb-bsd-sockets:socket-connect
                     socket (sb-bsd-sockets:make-inet-address "127.0.0.1") port)
                    t)
          (ignore-errors (sb-bsd-sockets:socket-close socket))))
    (error () nil)))

(defun port-ours-to-take-p (port)
  "May this cell serve on https PORT? (values OKP WHY). A port with no config
is free; one whose handler is our own loopback proxy, from a run that died
before it could take it down, is ours to take back; anything else is someone
else's and is left alone."
  (let ((target (served-target-at port)))
    (cond
      ((null target) (values t nil))
      ((and (loopback-target-p target)
            (not (listening-p (parse-integer (subseq target (length "http://127.0.0.1:"))))))
       (values t nil))
      (t (values nil (format nil "port ~d already serves ~a here"
                             port (if (stringp target) target "something else")))))))

(defun serve-on (target-port)
  "Serve this bridge on an https port of its own => (values OKP WHY PORT). The
port asked for, unless this node already serves something else there: then the
next free one in the span. 443 is never taken, and no path under it."
  (let ((chosen nil) (why nil)
        (preferred (bridge-https-port)))
    (loop for port from preferred below (+ preferred *bridge-port-span*)
          do (multiple-value-bind (free reason) (port-ours-to-take-p port)
               (if free (progn (setf chosen port) (return)) (setf why reason))))
    (unless chosen
      (return-from serve-on
        (values nil (or why (format nil "no free https port in ~d..~d"
                                    preferred (+ preferred (1- *bridge-port-span*))))
                nil)))
    (multiple-value-bind (output okp)
        (run-tailscale "serve" "--bg" (format nil "--https=~d" chosen)
                       (format nil "http://127.0.0.1:~d" target-port))
      (values okp output chosen))))

(defun serve-off ()
  "Take this bridge's own https port back down, and nothing else: 443 is not
this cell's to touch, and neither is any other port the node serves."
  (run-tailscale "serve" (format nil "--https=~d" (or (getf *bridge* :https-port)
                                                       (bridge-https-port)))
                 "off"))

(defun bridge-running-p ()
  "Is remote access on?"
  (and *bridge* (getf *bridge* :server) t))

(defun bridge-start ()
  "Turn remote access on => (values OKP WHY). Nothing is added to the tailnet
but serve's own https listener; this bridge is behind it, on loopback."
  (when (bridge-running-p)
    (return-from bridge-start (values t "already on")))
  (let ((login (tailnet-login)) (name (tailnet-name)))
    (unless name
      (return-from bridge-start (values nil "this machine is not on a tailnet")))
    (unless login
      (return-from bridge-start (values nil "tailscale did not say whose tailnet this is")))
    (unless (plusp (gateway-port))
      (return-from bridge-start (values nil "this organism has not published a port")))
    (let* ((port (free-loopback-port))
           (server (handler-case (bridge-listener port)
                     (error (condition)
                       (return-from bridge-start
                         (values nil (format nil "nothing could listen behind it: ~a" condition)))))))
      (setf *bridge* (list :server server :port port :login login :name name
                           :code nil :code-expires nil))
      (setf (getf *bridge* :thread)
            (sb-thread:make-thread (lambda () (bridge-accept-loop server)) :name "web bridge"))
      (multiple-value-bind (okp why https)
          ;; A serve that signals rather than answers would leave the listener
          ;; up and the bridge marked on with no tunnel behind it, so it is
          ;; caught here and taken down the same way.
          (handler-case (serve-on port)
            (error (condition) (values nil (princ-to-string condition) nil)))
        (unless okp
          (ignore-errors (sb-bsd-sockets:socket-close server))
          (setf *bridge* nil)
          (return-from bridge-start
            (values nil (format nil "tailscale would not serve it: ~a" why))))
        ;; The port it took, not the one asked for: a device's address and the
        ;; teardown both follow this, so nothing is ever taken down blind.
        (setf (getf *bridge* :https-port) https)
        (keep-intent t)
        (mint-code))
      (values t (bridge-address)))))

(defun bridge-stop ()
  "Turn remote access off, and stop answering."
  (let ((state *bridge*))
    (when state
      (ignore-errors (sb-bsd-sockets:socket-close (getf state :server)))
      (serve-off)
      (ignore-errors (sb-thread:join-thread (getf state :thread) :timeout 3))
      (setf *bridge* nil))
    (keep-intent nil)
    t))

(defun bridge-resume ()
  "Start remote access again for a boot that finds it was left on. The process
that held the tunnel is gone, and the serve entry tailscaled kept now points
at a port nothing listens on, so the wish is re-made: a fresh port, serve
re-aimed at it, and the paired devices as they were. In a thread, because the
cell loads before the gateway has published the port it forwards to."
  (when (bridge-intended-p)
    (sb-thread:make-thread
     (lambda ()
       (loop repeat 600
             until (plusp (gateway-port))
             do (sleep 0.2))
       (multiple-value-bind (okp why) (bridge-start)
         (unless okp
           (setf *bridge-error* why))))
     :name "web bridge resume")))

;;; --- what the panel reads -----------------------------------------------

(defun device-json ()
  "The paired devices, as the panel lists them."
  (let ((rows '()))
    (loop for device across (read-devices)
          for at from 0
          do (push (nlk:json-object
                    "index" at
                    "name" (or (nlk:json-value device :text "name") "a device")
                    "login" (or (nlk:json-value device :text "login") "")
                    "created" (or (nlk:json-value device :integer "created") 0))
                   rows))
    (coerce (nreverse rows) 'simple-vector)))

(defun tailnet-https-p ()
  "May this node have an https certificate? Tailscale grants it per node, and
names the domains it would issue for: both are in the status this reads, so
the question is answered without asking for a certificate."
  (let* ((status (tailnet-status))
         (self (and status (gethash "Self" status)))
         (caps (and (hash-table-p self) (gethash "Capabilities" self)))
         (domains (and status (gethash "CertDomains" status))))
    (and (plusp (length (or domains #())))
         (some (lambda (cap) (and (stringp cap) (string= cap "https")))
               (coerce (or caps #()) 'list))
         t)))

(defun tailnet-advice ()
  "What stands in the way of serving this page, and where to take that step,
in the order the steps have to be taken. NIL when nothing does."
  (cond
    ((null (tailscale-binary))
     (nlk:json-object
      "reason" "not_installed"
      "text" "Tailscale is not installed on this machine, so there is no tailnet address to serve this page at."
      "step" "Install it from tailscale.com/download, run `tailscale up' and sign in. Nothing else is needed: the tailnet's own https address is what this page is served at, and it is the only address it is served at."
      "label" "Get Tailscale"
      "url" "https://tailscale.com/download"))
    ((null (tailnet-name))
     (nlk:json-object
      "reason" "not_connected"
      "text" "Tailscale is here, but this machine is not on a tailnet yet."
      "step" "Run `tailscale up' and sign in for the account that owns this machine. Its address appears here once it is connected."
      "label" "Tailscale"
      "url" "https://login.tailscale.com/admin/machines"))
    ((not (tailnet-https-p))
     (nlk:json-object
      "reason" "no_https"
      "text" "This tailnet may not issue an https certificate for this machine, so there is no secure address to serve the page at."
      "step" "Switch on HTTPS certificates for the tailnet, once, in the admin console: DNS, then HTTPS Certificates. It takes effect in about a minute and needs no restart."
      "label" "Open the DNS settings"
      "url" "https://login.tailscale.com/admin/dns"))
    (t :null)))

(defun bridge-json ()
  "Remote access as the panel reads it. A refusal is read once: the panel is
not a log, and a line about a request that failed an hour ago reads as a fault."
  (let ((running (bridge-running-p))
        (refusal *bridge-refusal*))
    (setf *bridge-refusal* nil)
    (nlk:json-object
     "available" (and (tailscale-binary) (tailnet-name) (tailnet-https-p) t)
     "https_port" (bridge-https-port)
     "address" (or (bridge-address) :null)
     "running" (and running t)
     "code" (if (code-live-p) (getf *bridge* :code) :null)
     "code_minutes" (round *bridge-code-seconds* 60)
     "devices" (device-json)
     "refusal" (or refusal :null)
     "advice" (tailnet-advice)
     "port" (if running (getf *bridge* :port) 0))))

(defun bridge-act (env)
  "POST {action}: start and stop remote access, mint a code, forget a device."
  (let ((octets (request-octets env *bridge-max-body*)))
    (unless octets
      (return-from bridge-act (tasks-refused 413 "too_large" "over the request ceiling")))
    (let* ((sent (handler-case (nlk:decode-json octets :whole t) (error () :bad)))
           (action (and (hash-table-p sent) (nlk:json-value sent :text "action"))))
      (unless (hash-table-p sent)
        (return-from bridge-act (tasks-refused 400 "not_json" "the body is not a JSON object")))
      (cond
        ((and action (string-equal action "start"))
         (multiple-value-bind (okp why) (bridge-start)
           (if okp
               (json-answer 200 (bridge-json))
               (tasks-refused 409 "would_not_start" (format nil "~a" why)))))
        ((and action (string-equal action "stop"))
         (bridge-stop)
         (json-answer 200 (bridge-json)))
        ((and action (string-equal action "code"))
         (unless (bridge-running-p)
           (return-from bridge-act (tasks-refused 409 "not_running" "remote access is off")))
         (mint-code)
         (json-answer 200 (bridge-json)))
        ((and action (string-equal action "forget"))
         (forget-device (nlk:json-value sent :integer "index"))
         (json-answer 200 (bridge-json)))
        (t (tasks-refused 400 "no_action" "action: start, stop, code or forget"))))))

(defun peers-route (env)
  "/api/remote/peers: the tailnet's machines that answer as a tailnet bridge,
this one among them, each with the address another machine would open."
  (if (member (getf env :request-method) '(:get :head))
      (let ((here (ignore-errors (string-right-trim "." (tailnet-name)))))
        (json-answer
         200
         (nlk:json-object
          "self" (or here :null)
          "machines"
          (coerce (loop for machine in (tailnet-machines)
                        collect (nlk:json-object
                                 "name" (or (nlk:json-value machine :text "name") "a machine")
                                 "host" (or (nlk:json-value machine :text "host") :null)
                                 "address" (or (nlk:json-value machine :text "address") :null)
                                 "port" (or (nlk:json-value machine :integer "port") :null)
                                 "current" (if (and here (string= (or (nlk:json-value machine :text "host") "") here))
                                               t
                                               :false)))
                  'vector))))
      (tasks-refused 405 "method" "GET reads the tailnet's machines")))

(defun bridge-route (env)
  "/api/web/bridge: GET how remote access stands; POST {action} starts or
stops it, mints a pairing code, or forgets a device."
  (case (getf env :request-method)
    ((:get :head) (bridge-json))
    (:post (bridge-act env))
    (t (tasks-refused 405 "method" "GET reads remote access; POST acts on it"))))

;; Remote access was left on, and the process that held it is not this one:
;; start it again, rather than leaving tailscaled serving a port nothing has.
;; Here, at the end of the last file this system loads: the wish is read only
;; once everything it needs is defined.
(bridge-resume)

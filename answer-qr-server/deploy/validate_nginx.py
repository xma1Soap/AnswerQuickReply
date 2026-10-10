#!/usr/bin/env python3
"""Run nginx -t against these templates without touching any installed site."""

import argparse
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nginx", default="nginx", help="Path to the nginx executable.")
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix="answer-qr-nginx-test-") as directory:
        root = Path(directory)
        (root / "logs").mkdir()
        includes = {
            "answer-qr-contribution-proxy.conf": "nginx-contribution-proxy.conf",
            "answer-qr-poll-proxy.conf": "nginx-poll-proxy.conf",
            "answer-qr-auth-entry-proxy.conf": "nginx-auth-entry-proxy.conf",
        }
        for target, filename in includes.items():
            (root / target).write_text((source / filename).read_text(encoding="utf-8"), encoding="utf-8")
        locations = (source / "nginx-contributions.conf").read_text(encoding="utf-8")
        for target in includes:
            locations = locations.replace("/etc/nginx/snippets/" + target, str(root / target))
        locations += (source / "nginx-location.conf").read_text(encoding="utf-8")
        zones = (source / "nginx-limit-zones.conf").read_text(encoding="utf-8")
        config = root / "nginx.conf"
        temporary_paths = "".join(directive + " " + str(root / name) + ";\n" for directive, name in (
            ("client_body_temp_path", "body"), ("proxy_temp_path", "proxy"),
            ("fastcgi_temp_path", "fastcgi"), ("uwsgi_temp_path", "uwsgi"), ("scgi_temp_path", "scgi")))
        config.write_text("pid nginx.pid;\nerror_log stderr;\nevents { worker_connections 64; }\n"
                          "http { access_log off;\n" + temporary_paths + zones +
                          "\nserver { listen 127.0.0.1:18765; server_name localhost;\n" +
                          locations + "\n} }\n", encoding="utf-8")
        # -t validates syntax and referenced paths only; it does not start a
        # server or bind the listen socket. All prefix files are temporary.
        result = subprocess.run([args.nginx, "-t", "-p", str(root) + "/", "-c", str(config)], check=False)
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())

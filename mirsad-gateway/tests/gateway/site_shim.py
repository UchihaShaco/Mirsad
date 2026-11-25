"""mitmproxy addon used only by the gateway tests: sends every *.test host to the local test sites.

It stands in for DNS so the gateway under test can be driven with readable host names.
"""

import os


class SiteShim:
    def __init__(self) -> None:
        self.http_port = int(os.environ["SHIM_HTTP_PORT"])
        self.https_port = int(os.environ["SHIM_HTTPS_PORT"])

    def server_connect(self, data) -> None:
        host, port = data.server.address
        if str(host).endswith(".test"):
            data.server.address = ("127.0.0.1", self.https_port if port == 443 else self.http_port)


addons = [SiteShim()]

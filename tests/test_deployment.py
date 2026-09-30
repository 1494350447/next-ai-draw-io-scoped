import copy
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("deploy_check", ROOT / "tools/deploy_check.py")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "name": "second-instance",
            "services": {"next-ai-draw-io": {
                "ports": [{"target": 3000, "published": "3301", "host_ip": "0.0.0.0"}],
                "build": {"args": {"NEXT_PUBLIC_BASE_PATH": "/tools/diagram"}},
            }},
        }

    def test_port_and_prefix_follow_resolved_compose_config(self):
        self.assertEqual(CHECK.deployment_settings(self.config), [
            "second-instance", "3301", "0.0.0.0", "/tools/diagram", "",
            "http://127.0.0.1:3301/tools/diagram",
        ])

    def test_specific_and_ipv6_bind_addresses(self):
        for bind, expected in [("192.0.2.10", "192.0.2.10"), ("::", "[::1]"), ("::1", "[::1]")]:
            with self.subTest(bind=bind):
                self.config["services"]["next-ai-draw-io"]["ports"][0]["host_ip"] = bind
                self.assertEqual(CHECK.deployment_settings(self.config)[-1], f"http://{expected}:3301/tools/diagram")

    def test_invalid_paths_are_rejected_before_build(self):
        for prefix in ["diagram", "/diagram/", "//diagram", "/../diagram", "/diagram?test", "/bad\npath"]:
            with self.subTest(prefix=prefix):
                self.config["services"]["next-ai-draw-io"]["build"]["args"]["NEXT_PUBLIC_BASE_PATH"] = prefix
                with self.assertRaises(RuntimeError):
                    CHECK.deployment_settings(self.config)

    def test_invalid_ports_and_canvas_urls_are_rejected(self):
        for port in ["0", "65536", "3000-3010"]:
            config = copy.deepcopy(self.config)
            config["services"]["next-ai-draw-io"]["ports"][0]["published"] = port
            with self.assertRaises(RuntimeError):
                CHECK.deployment_settings(config)
        for url in ["/drawio", "javascript:alert(1)", "https://user:secret@example.com", "https://example.com/#fragment"]:
            self.config["services"]["next-ai-draw-io"]["build"]["args"]["NEXT_PUBLIC_DRAWIO_BASE_URL"] = url
            with self.assertRaises(RuntimeError):
                CHECK.deployment_settings(self.config)


if __name__ == "__main__":
    unittest.main()

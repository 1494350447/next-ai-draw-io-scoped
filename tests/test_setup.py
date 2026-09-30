import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        shutil.copy2(ROOT / "setup.sh", self.directory / "setup.sh")
        shutil.copy2(ROOT / "install-env.sh", self.directory / "install-env.sh")
        shutil.copy2(ROOT / ".env.example", self.directory / ".env.example")
        self.trace = self.directory / "trace"
        self.environment = dict(os.environ, SETUP_TRACE=str(self.trace))
        self.environment.pop("DEPLOY_REPO_DIR", None)
        self.environment.pop("WAIT_TIMEOUT", None)

    def fake_deploy(self):
        (self.directory / "deploy.sh").write_text(
            '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$1" >> "$SETUP_TRACE"\n'
            'if [[ "$1" == "init" ]]; then cp "$(dirname "$0")/.env.example" "$(dirname "$0")/.env"; fi\n'
            'if [[ "$1" == "${FAIL_STAGE:-}" ]]; then exit 7; fi\n'
        )

    def run_setup(self, *arguments):
        return subprocess.run(
            ["bash", str(self.directory / "setup.sh"), *arguments],
            cwd="/tmp", env=self.environment, input="", text=True, capture_output=True,
        )

    def run_environment(self, *arguments):
        return subprocess.run(
            ["bash", str(self.directory / "install-env.sh"), *arguments],
            cwd="/tmp", env=self.environment, input="", text=True, capture_output=True,
        )

    def test_project_install_preserves_configuration_without_smoke(self):
        self.fake_deploy()
        config = self.directory / ".env"
        config.write_text("existing-private-config")
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(config.read_text(), "existing-private-config")
        self.assertEqual(self.trace.read_text().splitlines(), ["environment", "deploy", "status"])

    def test_check_is_read_only_and_rejects_install_flags(self):
        self.fake_deploy()
        result = self.run_setup("--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.trace.read_text().splitlines(), ["environment", "doctor"])
        self.assertFalse((self.directory / ".env").exists())
        self.trace.unlink()
        result = self.run_setup("--check", "--install-deps")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.trace.exists())

    def test_unattended_first_run_does_not_deploy_empty_key(self):
        self.fake_deploy()
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.directory / ".env").exists())
        self.assertEqual(self.trace.read_text().splitlines(), ["environment", "init"])

    def test_failures_stop_following_stages(self):
        self.fake_deploy()
        (self.directory / ".env").write_text("test-config")
        for stage in ("environment", "deploy", "status"):
            with self.subTest(stage=stage):
                self.environment["FAIL_STAGE"] = stage
                result = self.run_setup()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.trace.read_text().splitlines()[-1], stage)
                self.trace.unlink()

    def test_config_wizard_protects_credentials_and_existing_file(self):
        spec = importlib.util.spec_from_file_location("setup_config", ROOT / "tools/setup_config.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.ROOT = self.directory
        with patch.object(module.sys.stdin, "isatty", return_value=True), \
             patch("builtins.input", return_value=""), \
             patch.object(module.getpass, "getpass", return_value="test-secret-$literal"):
            module.main()
        config = self.directory / ".env"
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        self.assertIn("DEEPSEEK_API_KEY='test-secret-$literal'", config.read_text())
        before = config.read_bytes()
        module.main()
        self.assertEqual(config.read_bytes(), before)

    def test_config_wizard_rejects_empty_key_without_creating_file(self):
        spec = importlib.util.spec_from_file_location("setup_config", ROOT / "tools/setup_config.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.ROOT = self.directory
        with patch.object(module.sys.stdin, "isatty", return_value=True), \
             patch("builtins.input", return_value=""), \
             patch.object(module.getpass, "getpass", return_value=""), \
             self.assertRaises(SystemExit):
            module.main()
        self.assertFalse((self.directory / ".env").exists())

    def test_real_environment_gate_checks_versions_permissions_and_ports(self):
        shutil.copy2(ROOT / "deploy.sh", self.directory / "deploy.sh")
        (self.directory / "tools").mkdir()
        shutil.copy2(ROOT / "tools/deploy_check.py", self.directory / "tools/deploy_check.py")
        binary = self.directory / "bin"
        binary.mkdir()
        for relative in (
            "Dockerfile", "docker-compose.yml", "app/api/scoped-edit/route.ts",
            "lib/scoped-edit.ts", "lib/scoped-rules.ts", "lib/model-request.ts", "lib/edit-diagram-tool.ts",
        ):
            target = self.directory / "upstream" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()
        docker = binary / "docker"
        docker.write_text(
            f"#!{sys.executable}\n"
            "import os,sys,json\n"
            "arguments=sys.argv[1:]\n"
            "if arguments[:2]==['compose','version']: print(os.getenv('MOCK_COMPOSE','2.24.4'))\n"
            "elif arguments[0]=='compose' and 'config' in arguments: print(json.dumps({'name':'test','services':{'next-ai-draw-io':{'ports':[{'target':3000,'published':'3300'}],'build':{'args':{}}}}}))\n"
            "elif arguments[0]=='version': print(os.getenv('MOCK_DOCKER','24.0.0'))\n"
            "elif arguments[0]=='info': sys.exit(int(os.getenv('MOCK_DENIED','0')))\n"
        )
        docker.chmod(0o755)
        socket = binary / "ss"
        socket.write_text(f"#!{sys.executable}\nimport os\nprint('LISTEN' if os.getenv('MOCK_CONFLICT') else '')\n")
        socket.chmod(0o755)
        self.environment["PATH"] = str(binary) + os.pathsep + os.environ["PATH"]
        baseline = subprocess.run(
            ["bash", str(self.directory / "deploy.sh"), "environment"],
            env=self.environment, capture_output=True, text=True,
        )
        self.assertEqual(baseline.returncode, 0, baseline.stderr)
        for variable, value in (
            ("MOCK_COMPOSE", "2.24.3"), ("MOCK_COMPOSE", "unknown"),
            ("MOCK_DOCKER", "23.0.6"), ("MOCK_DENIED", "1"), ("MOCK_CONFLICT", "1"),
        ):
            with self.subTest(variable=variable, value=value):
                result = subprocess.run(
                    ["bash", str(self.directory / "deploy.sh"), "environment"],
                    env=dict(self.environment, **{variable: value}), capture_output=True, text=True,
                )
                self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_missing_docker_install_commands_and_failure_propagation(self):
        release = Path("/etc/os-release").read_text()
        if "ID=ubuntu\n" not in release or 'VERSION_ID="24.04"' not in release:
            self.skipTest("Dependency installer targets Ubuntu 24.04")
        binary = self.directory / "bin"
        binary.mkdir()
        for command in ("dirname", "uname", "python3", "curl", "ss", "sha256sum", "bash"):
            resolved = shutil.which(command)
            if not resolved:
                self.skipTest(f"Missing test prerequisite: {command}")
            (binary / command).symlink_to(resolved)
        docker_source = '#!/bin/bash\nif [[ "$1" == compose ]]; then echo 2.24.4; elif [[ "$1" == version ]]; then echo 24.0.0; fi\n'
        apt = binary / "apt-get"
        apt.write_text(
            f"#!{sys.executable}\nimport os,sys,pathlib\n"
            "with open(os.environ['SETUP_TRACE'], 'a') as output: output.write('apt-get ' + ' '.join(sys.argv[1:]) + '\\n')\n"
            "if os.getenv('FAIL_APT') == '1': sys.exit(9)\n"
            "if sys.argv[1] == 'install':\n"
            "    target = pathlib.Path(__file__).parent / 'docker'\n"
            f"    target.write_text({docker_source!r})\n"
            "    target.chmod(0o755)\n"
        )
        apt.chmod(0o755)
        systemctl = binary / "systemctl"
        systemctl.write_text('#!/bin/bash\nprintf "systemctl %s\\n" "$*" >> "$SETUP_TRACE"\n')
        systemctl.chmod(0o755)
        sudo = binary / "sudo"
        sudo.write_text('#!/bin/bash\nexec "$@"\n')
        sudo.chmod(0o755)
        self.environment["PATH"] = str(binary)
        check = self.run_environment("--check")
        self.assertNotEqual(check.returncode, 0)
        self.assertFalse(self.trace.exists())
        result = self.run_environment()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.trace.read_text().splitlines()
        self.assertIn("apt-get update", calls)
        self.assertIn("apt-get install --no-remove --no-install-recommends -y docker.io docker-compose-v2", calls)
        self.assertIn("systemctl enable --now docker", calls)
        self.assertEqual(len(calls), 3)
        self.assertFalse((self.directory / ".env").exists())
        self.assertFalse((self.directory / "deploy.sh").exists())
        self.assertEqual(self.run_environment("--check").returncode, 0)
        self.assertEqual(self.trace.read_text().splitlines(), calls)
        self.trace.unlink()
        (binary / "docker").unlink()
        self.environment["FAIL_APT"] = "1"
        failed = self.run_environment()
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(self.trace.read_text().splitlines(), ["apt-get update"])


if __name__ == "__main__":
    unittest.main()

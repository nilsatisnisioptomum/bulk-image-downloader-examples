"""Offline regression tests; no SDK installation, token or network required."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import runpy
import socket
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
import zipfile

RECIPE = Path(__file__).resolve().parents[1] / "python" / "download_images_to_zip.py"


def archive_bytes():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("001-product.txt", "Synthetic product image fixture")
    return output.getvalue()


class Response(io.BytesIO):
    def __init__(self, body, fail_after=None, chunk_limit=None):
        super().__init__(body)
        self.fail_after = fail_after
        self.chunk_limit = chunk_limit
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        if self.fail_after is not None and self.tell() >= self.fail_after:
            raise OSError("Synthetic interrupted download")
        return super().read(min(size, self.chunk_limit) if self.chunk_limit else size)


class PythonDownloadTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.output = self.directory / "files.zip"
        self.sdk = types.ModuleType("apify_client")
        self.client = Mock()
        self.sdk.ApifyClient = Mock(return_value=self.client)
        self.actor_call = self.client.actor.return_value.call
        self.actor_call.return_value = {
            "defaultDatasetId": "synthetic-dataset",
            "defaultKeyValueStoreId": "synthetic-store",
        }
        self.client.dataset.return_value.iterate_items.return_value = iter([])
        self.modules = patch.dict(sys.modules, {"apify_client": self.sdk})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        spec = importlib.util.spec_from_file_location("recipe_under_test", RECIPE)
        self.recipe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.recipe)
        self.environment = patch.dict(os.environ, {"APIFY_TOKEN": "synthetic-offline-token"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.urlopen = patch.object(self.recipe.urllib.request, "urlopen").start()
        self.addCleanup(patch.stopall)
        self.socket = patch.object(socket, "create_connection", side_effect=AssertionError("Network forbidden")).start()
        self.body = archive_bytes()
        self.urlopen.return_value = Response(self.body)
        self.stdout = io.StringIO()
        self.capture = contextlib.redirect_stdout(self.stdout)
        self.capture.__enter__()
        self.addCleanup(self.capture.__exit__, None, None, None)

    def run_download(self):
        self.recipe.download_to_zip(["https://example.com/001-product.png"], self.output)

    def assert_not_started(self):
        self.sdk.ApifyClient.assert_not_called()
        self.actor_call.assert_not_called()
        self.urlopen.assert_not_called()
        self.socket.assert_not_called()

    def test_existing_output_preserved_before_any_actor_call(self):
        self.output.write_bytes(b"existing customer archive")
        with self.assertRaises(FileExistsError):
            self.run_download()
        self.assertEqual(self.output.read_bytes(), b"existing customer archive")
        self.assert_not_started()

    @unittest.skipUnless(hasattr(os, "symlink"), "Symlinks unavailable")
    def test_existing_symlink_preserves_link_and_target_without_actor_call(self):
        target = self.directory / "original.zip"
        target.write_bytes(b"valuable archive")
        self.output.symlink_to(target)
        with self.assertRaises(FileExistsError):
            self.run_download()
        self.assertTrue(self.output.is_symlink())
        self.assertEqual(target.read_bytes(), b"valuable archive")
        self.assert_not_started()

    @unittest.skipUnless(hasattr(os, "symlink"), "Symlinks unavailable")
    def test_dangling_symlink_preserved_without_actor_call(self):
        self.output.symlink_to(self.directory / "missing.zip")
        with self.assertRaises(FileExistsError):
            self.run_download()
        self.assertTrue(self.output.is_symlink())
        self.assert_not_started()

    def test_success_saves_exact_valid_zip_and_authenticates_download(self):
        response = Response(self.body, chunk_limit=2)
        self.urlopen.return_value = response
        self.run_download()
        self.assertEqual(self.output.read_bytes(), self.body)
        with zipfile.ZipFile(self.output) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(archive.read("001-product.txt"), b"Synthetic product image fixture")
        self.actor_call.assert_called_once_with(run_input={
            "urls": ["https://example.com/001-product.png"], "createZip": True, "maxFiles": 1,
        })
        request = self.urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.apify.com/v2/key-value-stores/synthetic-store/records/OUTPUT.zip")
        self.assertEqual(request.get_header("Authorization"), "Bearer synthetic-offline-token")
        self.assertEqual(self.urlopen.call_args.kwargs, {"timeout": 75})
        self.assertTrue(all(size == 1024 * 1024 for size in response.read_sizes))
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(self.output.stat().st_mode) & 0o077, 0)
        self.assertEqual(self.stdout.getvalue(), "Saved files.zip\n")
        self.socket.assert_not_called()

    def test_actor_start_failure_removes_only_reserved_output(self):
        self.actor_call.side_effect = RuntimeError("Synthetic start failure")
        with self.assertRaisesRegex(RuntimeError, "Synthetic start failure"):
            self.run_download()
        self.assertFalse(self.output.exists())
        self.urlopen.assert_not_called()
        self.assertNotIn("Saved", self.stdout.getvalue())

    def test_dataset_read_failure_removes_reserved_output(self):
        self.client.dataset.return_value.iterate_items.side_effect = RuntimeError("Synthetic dataset read failure")
        with self.assertRaisesRegex(RuntimeError, "Synthetic dataset read failure"):
            self.run_download()
        self.assertFalse(self.output.exists())
        self.urlopen.assert_not_called()

    def test_http_open_failure_removes_reserved_output(self):
        self.urlopen.side_effect = OSError("Synthetic HTTP failure")
        with self.assertRaisesRegex(OSError, "Synthetic HTTP failure"):
            self.run_download()
        self.assertFalse(self.output.exists())
        self.assertNotIn("Saved", self.stdout.getvalue())

    def test_interrupted_read_removes_new_partial_file_and_never_says_saved(self):
        self.urlopen.return_value = Response(self.body, fail_after=2, chunk_limit=2)
        with self.assertRaisesRegex(OSError, "Synthetic interrupted download"):
            self.run_download()
        self.assertFalse(self.output.exists())
        self.assertNotIn("Saved", self.stdout.getvalue())

    def test_user_replacement_during_failed_run_is_preserved(self):
        def replace_then_fail(**kwargs):
            self.output.unlink()
            self.output.write_bytes(b"user replacement")
            raise RuntimeError("Synthetic failed run after replacement")
        self.actor_call.side_effect = replace_then_fail
        with self.assertRaisesRegex(RuntimeError, "after replacement"):
            self.run_download()
        self.assertEqual(self.output.read_bytes(), b"user replacement")
        self.assertNotIn("Saved", self.stdout.getvalue())

    @unittest.skipUnless(hasattr(os, "symlink"), "Symlinks unavailable")
    def test_user_symlink_replacement_during_failed_run_is_preserved(self):
        target = self.directory / "replacement.zip"
        target.write_bytes(b"user replacement archive")
        def replace_then_fail(**kwargs):
            self.output.unlink()
            self.output.symlink_to(target)
            raise RuntimeError("Synthetic failed run after symlink replacement")
        self.actor_call.side_effect = replace_then_fail
        with self.assertRaisesRegex(RuntimeError, "after symlink replacement"):
            self.run_download()
        self.assertTrue(self.output.is_symlink())
        self.assertEqual(target.read_bytes(), b"user replacement archive")

    def test_user_replacement_during_success_is_preserved_without_saved_claim(self):
        run = self.actor_call.return_value
        def replace_then_succeed(**kwargs):
            self.output.unlink()
            self.output.write_bytes(b"user replacement")
            return run
        self.actor_call.side_effect = replace_then_succeed
        with self.assertRaisesRegex(RuntimeError, "Output file changed"):
            self.run_download()
        self.assertEqual(self.output.read_bytes(), b"user replacement")
        self.assertNotIn("Saved", self.stdout.getvalue())

    def test_user_deletion_during_success_has_no_saved_claim(self):
        run = self.actor_call.return_value
        def delete_then_succeed(**kwargs):
            self.output.unlink()
            return run
        self.actor_call.side_effect = delete_then_succeed
        with self.assertRaisesRegex(RuntimeError, "Output file changed"):
            self.run_download()
        self.assertFalse(self.output.exists())
        self.assertNotIn("Saved", self.stdout.getvalue())

    def test_response_context_close_failure_removes_completed_bytes_without_saved(self):
        class CloseFailureResponse(Response):
            def __exit__(self, *args):
                super().__exit__(*args)
                raise OSError("Synthetic response close failure")
        self.urlopen.return_value = CloseFailureResponse(self.body)
        with self.assertRaisesRegex(OSError, "response close failure"):
            self.run_download()
        self.assertFalse(self.output.exists())
        self.assertNotIn("Saved", self.stdout.getvalue())

    def test_destination_flush_failure_removes_partial_without_saved(self):
        class FailingRaw(io.FileIO):
            def write(self, data):
                raise OSError("Synthetic destination flush failure")
        def failing_writer(fd, mode):
            return io.BufferedWriter(FailingRaw(fd, mode))
        with patch.object(self.recipe.os, "fdopen", side_effect=failing_writer):
            with self.assertRaisesRegex(OSError, "destination flush failure"):
                self.run_download()
        self.assertFalse(self.output.exists())
        self.assertNotIn("Saved", self.stdout.getvalue())

    def test_destination_close_failure_removes_partial_without_saved(self):
        real_fdopen = os.fdopen
        class CloseFailureWriter:
            def __init__(self, fd, mode):
                self.inner = real_fdopen(fd, mode)
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.close()
            @property
            def closed(self):
                return self.inner.closed
            def write(self, data):
                return self.inner.write(data)
            def close(self):
                self.inner.close()
                raise OSError("Synthetic destination close failure")
        with patch.object(self.recipe.os, "fdopen", side_effect=CloseFailureWriter):
            with self.assertRaisesRegex(OSError, "destination close failure"):
                self.run_download()
        self.assertFalse(self.output.exists())
        self.assertNotIn("Saved", self.stdout.getvalue())

    def test_sdk_construction_failure_removes_reserved_output(self):
        self.sdk.ApifyClient.side_effect = RuntimeError("Synthetic SDK failure")
        with self.assertRaisesRegex(RuntimeError, "Synthetic SDK failure"):
            self.run_download()
        self.assertFalse(self.output.exists())
        self.actor_call.assert_not_called()
        self.urlopen.assert_not_called()

    def test_non_zip_response_rejected_and_removed(self):
        self.urlopen.return_value = Response(b"<html>error</html>")
        with self.assertRaisesRegex(ValueError, "not a ZIP"):
            self.run_download()
        self.assertFalse(self.output.exists())

    def test_empty_zip_rejected_and_removed(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w"):
            pass
        self.urlopen.return_value = Response(output.getvalue())
        with self.assertRaisesRegex(ValueError, "ZIP is empty"):
            self.run_download()
        self.assertFalse(self.output.exists())

    def test_oversize_response_rejected_and_removed(self):
        with patch.object(self.recipe, "MAX_ZIP_BYTES", len(self.body) - 1):
            with self.assertRaisesRegex(ValueError, "exceeds"):
                self.run_download()
        self.assertFalse(self.output.exists())

    def test_missing_token_removes_reserved_output_without_start(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(KeyError):
                self.run_download()
        self.assertFalse(self.output.exists())
        self.assert_not_started()

    def test_cli_retains_url_list_and_default_output_behavior(self):
        source = self.directory / "urls.txt"
        source.write_text("\nhttps://example.com/001-product.png\nnot-a-url\n", encoding="utf-8")
        previous = Path.cwd()
        try:
            os.chdir(self.directory)
            with patch.object(sys, "argv", [str(RECIPE), str(source)]):
                runpy.run_path(str(RECIPE), run_name="__main__")
        finally:
            os.chdir(previous)
        self.assertEqual(self.output.read_bytes(), self.body)
        self.assertEqual(self.actor_call.call_args.kwargs["run_input"]["urls"], ["https://example.com/001-product.png"])


if __name__ == "__main__":
    unittest.main()

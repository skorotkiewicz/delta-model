"""Download Qwen3-0.6B into the directory used by serve.py."""

import argparse
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent
MODEL_ID = "Qwen/Qwen3-0.6B"
DEFAULT_OUTPUT = ROOT / "resources" / "data-3-0.6b"
FILES = ["*.json", "*.safetensors", "*.txt", "*.model", "*.jinja", "README.md", "LICENSE*"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT,
                        help="Model directory, default: resources/data-3-0.6b next to this script")
    parser.add_argument("--revision", default="main", help="Hugging Face branch, tag or commit, default: main")
    parser.add_argument("--dry-run", action="store_true", help="Show required download size without downloading files")
    args = parser.parse_args()
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        parser.exit(1, 'Install the downloader dependency first: python -m pip install "huggingface-hub>=1.0"\n')

    output = args.output.expanduser().resolve()
    print(f"Model: {MODEL_ID} @ {args.revision}\nDestination: {output}", flush=True)
    try:
        result = snapshot_download(
            MODEL_ID, revision=args.revision, local_dir=output,
            allow_patterns=FILES, dry_run=args.dry_run,
        )
    except KeyboardInterrupt:
        parser.exit(130, "\nDownload interrupted. Run the same command to continue.\n")
    except Exception as error:
        parser.exit(1, f"Download failed: {error}\nRun the same command to retry.\n")

    if args.dry_run:
        pending = [file for file in result if file.will_download]
        size = sum(file.file_size for file in pending) / 1024**3
        print(f"Would download {len(pending)} of {len(result)} files, {size:.2f} GiB.")
        return

    required = ["config.json", "tokenizer_config.json", "tokenizer.json"]
    missing = [name for name in required if not (output / name).is_file()]
    if missing or not any(output.glob("*.safetensors")):
        parser.exit(1, f"Model download is incomplete. Missing required files or weights in {output}.\n")
    print("Model ready. Start the server with:")
    command = [sys.executable, str(ROOT / "serve.py"), "--port", "8765"]
    if output != DEFAULT_OUTPUT:
        command.extend(["--model", str(output)])
    # Display a copyable command without executing another process.
    import shlex
    import subprocess
    print(subprocess.list2cmdline(command) if sys.platform == "win32" else shlex.join(command))


if __name__ == "__main__":
    main()

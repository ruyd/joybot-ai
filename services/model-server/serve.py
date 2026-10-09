"""Starts vLLM for the configured Gemma 4 variant (plan.md §6).

Weights come from the private S3 cache when present; otherwise they are downloaded once from
Hugging Face (gated: needs HF_TOKEN) and uploaded to the cache, so later cold starts never leave AWS.

Environment:
  MODEL_ID            Hugging Face repo, e.g. google/gemma-4-E2B-it
  SERVED_MODEL_NAME   name clients use in requests (default: gemma)
  WEIGHTS_BUCKET      private S3 bucket for the weights cache (optional)
  MAX_MODEL_LEN       context length (default: 16384)
  TOOL_CALL_PARSER    vLLM tool-call parser; empty disables tool calling (set after the Phase 0 benchmark)
  VLLM_EXTRA_ARGS     extra vLLM flags, e.g. "--quantization fp8"
  HF_TOKEN            Hugging Face token (from Secrets Manager)
"""
import os
import pathlib
import shlex
import sys

MODEL_ID = os.environ["MODEL_ID"]
SERVED_NAME = os.environ.get("SERVED_MODEL_NAME", "gemma")
BUCKET = os.environ.get("WEIGHTS_BUCKET", "")
CACHE_PREFIX = f"models/{MODEL_ID}/"
LOCAL_DIR = pathlib.Path("/models") / MODEL_ID.replace("/", "--")
WEIGHT_PATTERNS = ["*.json", "*.safetensors", "*.model", "*.txt", "*.jinja", "tokenizer*"]


def log(msg: str) -> None:
    print(f"[joybot-model-server] {msg}", flush=True)


def complete(path: pathlib.Path) -> bool:
    return (path / "config.json").exists() and any(path.glob("*.safetensors"))


def from_s3() -> bool:
    if not BUCKET:
        return False
    import boto3

    s3 = boto3.client("s3")
    keys = [
        obj["Key"]
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=CACHE_PREFIX)
        for obj in page.get("Contents", [])
    ]
    if not keys:
        return False
    log(f"restoring {len(keys)} files from s3://{BUCKET}/{CACHE_PREFIX}")
    for key in keys:
        target = LOCAL_DIR / key[len(CACHE_PREFIX):]
        target.parent.mkdir(parents=True, exist_ok=True)
        s3.download_file(BUCKET, key, str(target))
    return complete(LOCAL_DIR)


def from_hugging_face() -> None:
    from huggingface_hub import snapshot_download

    log(f"downloading {MODEL_ID} from Hugging Face")
    snapshot_download(MODEL_ID, local_dir=LOCAL_DIR, allow_patterns=WEIGHT_PATTERNS, token=os.environ.get("HF_TOKEN"))
    if BUCKET:
        import boto3

        s3 = boto3.client("s3")
        for path in LOCAL_DIR.rglob("*"):
            if path.is_file() and ".cache" not in path.parts:
                s3.upload_file(str(path), BUCKET, CACHE_PREFIX + str(path.relative_to(LOCAL_DIR)))
        log(f"cached weights in s3://{BUCKET}/{CACHE_PREFIX}")


def main() -> None:
    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    if complete(LOCAL_DIR):
        log("using weights already on this instance")
    elif not from_s3():
        from_hugging_face()
    if not complete(LOCAL_DIR):
        log("model weights are incomplete")
        sys.exit(1)

    args = [
        "vllm", "serve", str(LOCAL_DIR),
        "--served-model-name", SERVED_NAME,
        "--host", "0.0.0.0",
        "--port", "8000",
        "--max-model-len", os.environ.get("MAX_MODEL_LEN", "16384"),
    ]
    parser = os.environ.get("TOOL_CALL_PARSER", "").strip()
    if parser:
        args += ["--enable-auto-tool-choice", "--tool-call-parser", parser]
    args += shlex.split(os.environ.get("VLLM_EXTRA_ARGS", ""))
    log("starting: " + " ".join(args))
    os.execvp(args[0], args)


if __name__ == "__main__":
    main()

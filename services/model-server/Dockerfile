# JoyBot model server: vLLM (OpenAI-compatible API) serving Gemma 4 on an NVIDIA GPU (linux/amd64).
#   docker build --platform linux/amd64 -t joybot/model-server:dev services/model-server
FROM vllm/vllm-openai:v0.30.0
RUN pip install --no-cache-dir boto3==1.40.40
COPY serve.py /opt/joybot/serve.py
ENTRYPOINT ["python3", "/opt/joybot/serve.py"]

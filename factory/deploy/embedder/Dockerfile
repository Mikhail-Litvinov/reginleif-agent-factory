FROM python:3.12-slim
RUN pip install --no-cache-dir onnxruntime==1.20.1 tokenizers==0.21.0 numpy==2.2.1
WORKDIR /app
COPY server.py forward.py /app/
USER 65532:65532
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "/app/server.py"]

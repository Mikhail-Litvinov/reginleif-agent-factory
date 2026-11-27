"""Loopback entry for the embedder.

Docker does not publish ports of an internal network, so the model container (internal network only, no route out)
cannot be reached from the host directly. This forwarder sits on both the internal network and a plain one; only it is
published, and it only relays bytes to the embedder's port.
"""
import asyncio
import os

TARGET = (os.environ.get("EMBEDDER_HOST", "embedder"), 8080)

async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except ConnectionError:
        pass
    finally:
        writer.close()

async def handle(client_reader, client_writer):
    try:
        upstream_reader, upstream_writer = await asyncio.open_connection(*TARGET)
    except OSError:
        client_writer.close()
        return
    await asyncio.gather(pipe(client_reader, upstream_writer), pipe(upstream_reader, client_writer))

async def main():
    server = await asyncio.start_server(handle, "0.0.0.0", 8080)
    async with server:
        await server.serve_forever()

if __name__ == "__main__":
    asyncio.run(main())

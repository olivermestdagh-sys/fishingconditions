"""R2 as service.py's `store`: get/put text, list and delete whole runs. Thin on purpose (all the logic is in publish.py).

Objects are written one at a time with a Content-Type and a Cache-Control: runs/<id>/... are immutable (a year), the pointer
files are short-lived (a minute), which is what makes an R2 custom domain + the browser cache a good fit for the site.
"""
import js
from pyodide.ffi import to_js


def _opts(d):
    return to_js(d, dict_converter=js.Object.fromEntries)


class R2Store:
    """A view of a bucket under `prefix` (""= the whole bucket). The shadow Worker uses one view for the recordings and one under
    "shadow/" for everything it writes, so its output can never collide with, or be mistaken for, a production layout."""

    def __init__(self, bucket, prefix=""):
        self.bucket = bucket
        self.prefix = prefix

    def view(self, prefix):
        return R2Store(self.bucket, self.prefix + prefix)

    async def list_keys(self, prefix=""):
        keys, cursor = [], None
        while True:
            o = {"prefix": self.prefix + prefix}
            if cursor:
                o["cursor"] = cursor
            res = await self.bucket.list(_opts(o))
            keys += [str(obj.key)[len(self.prefix):] for obj in res.objects]
            if not res.truncated:
                return keys
            cursor = res.cursor

    async def delete_key(self, key):
        await self.bucket.delete(self.prefix + key)

    async def get_text(self, key):
        obj = await self.bucket.get(self.prefix + key)
        if obj is None or str(obj) == "null":
            return None
        return await obj.text()

    async def exists(self, key):
        obj = await self.bucket.head(self.prefix + key)
        return not (obj is None or str(obj) == "null")

    async def put_text(self, key, text, content_type="application/json", cache_control=None):
        meta = {"contentType": content_type}
        if cache_control:
            meta["cacheControl"] = cache_control
        await self.bucket.put(self.prefix + key, text, _opts({"httpMetadata": meta}))

    async def list_run_ids(self):
        ids, cursor = [], None
        while True:
            o = {"prefix": self.prefix + "runs/", "delimiter": "/"}
            if cursor:
                o["cursor"] = cursor
            res = await self.bucket.list(_opts(o))
            ids += [str(p)[len(self.prefix + "runs/"):].rstrip("/") for p in res.delimitedPrefixes]  # iterate the JS array: no to_py() surprises
            if not res.truncated:
                return ids
            cursor = res.cursor

    async def delete_run(self, run_id):
        prefix, cursor = f"{self.prefix}runs/{run_id}/", None
        while True:
            o = {"prefix": prefix}
            if cursor:
                o["cursor"] = cursor
            res = await self.bucket.list(_opts(o))
            keys = [str(obj.key) for obj in res.objects]
            if keys:
                await self.bucket.delete(to_js(keys))
            if not res.truncated:
                return
            cursor = res.cursor

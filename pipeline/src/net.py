"""HTTP with retries, timeouts and per-host statistics, over an injected transport (entry.py supplies js.fetch; tests supply a fake).

Retry policy (a deliberate, small deviation from the script's urllib helper, which retried EVERY failure 3 times):
  * network errors, timeouts, 408/425/429 and 5xx are retried up to `tries` times with exponential backoff + jitter, and a
    Retry-After header (capped) is honoured;
  * other 4xx (a bad request, a wrong id, 401/403/404) are NOT retried: asking again cannot change the answer, and every
    WillyWeather request is billed;
  * on WillyWeather a network error / timeout is NOT retried either: the request may already have reached the API and been
    billed, so asking again could bill it twice (free hosts are retried);
  * WillyWeather has a per-run request BUDGET: once spent, further requests fail without being sent, so no bug or outage can
    multiply the bill (a normal run makes 27 requests);
  * a run DEADLINE: after it, nothing more is sent.
The API key travels inside WillyWeather URLs, so URLs are never logged or stored: errors are reduced to a type and a short,
key-scrubbed message.
"""
import asyncio
import random

RETRY_STATUS = {408, 425, 429}
MAX_RETRY_AFTER_S = 30


def scrub(text, secret):
    text = str(text)
    return text.replace(secret, "[key]") if secret else text


class Stats:
    def __init__(self):
        self.by_host = {}
        self.errors = []

    def add(self, host, status, nbytes, ms, retried):
        h = self.by_host.setdefault(host, {"calls": 0, "status": {}, "bytes": 0, "max_bytes": 0, "ms": 0, "max_ms": 0, "retries": 0})
        h["calls"] += 1
        h["status"][str(status)] = h["status"].get(str(status), 0) + 1
        h["bytes"] += nbytes
        h["max_bytes"] = max(h["max_bytes"], nbytes)
        h["ms"] += ms
        h["max_ms"] = max(h["max_ms"], ms)
        h["retries"] += retried

    def total_calls(self):
        return sum(h["calls"] for h in self.by_host.values())


class Net:
    def __init__(self, transport, *, secret="", tries=3, backoff=2.0, sleep=asyncio.sleep, clock=None, jitter=random.random,
                 budgets=None, no_retry_errors=("willyweather",), deadline=None):
        self.transport, self.secret, self.tries, self.backoff = transport, secret, tries, backoff
        self.sleep, self.jitter = sleep, jitter
        import time
        self.clock = clock or time.time
        self.budgets = dict(budgets or {})          # host -> attempts still allowed this run
        self.no_retry_errors = set(no_retry_errors)  # hosts where a raised error (timeout) is not retried
        self.deadline = deadline                     # absolute clock() value, or None
        self.stats = Stats()

    async def request(self, method, url, host, headers=None, body=None, tries=None):
        """Returns (status, text) of the final attempt, or (0, "") if every attempt raised."""
        tries = tries or self.tries
        status, text = 0, ""
        for attempt in range(tries):
            if self.deadline is not None and self.clock() > self.deadline:
                self.stats.errors.append("run deadline passed: request not sent")
                return 0, ""
            if host in self.budgets:
                if self.budgets[host] <= 0:
                    self.stats.errors.append(f"{host} request budget spent: request not sent")
                    return 0, ""
                self.budgets[host] -= 1
            t0 = self.clock()
            retry_after = None
            raised = False
            try:
                status, text, retry_after = await self.transport(method, url, headers or {}, body)
            except Exception as e:  # noqa: BLE001 - network failure / timeout
                status, text, raised = 0, "", True
                self.stats.errors.append(scrub(f"{type(e).__name__}: {e}", self.secret)[:120])
            self.stats.add(host, status, len(text), int((self.clock() - t0) * 1000), attempt)
            if 200 <= status < 300:
                return status, text
            if raised and host in self.no_retry_errors:
                break
            retryable = status == 0 or status in RETRY_STATUS or status >= 500
            if not retryable or attempt == tries - 1:
                break
            wait = self.backoff * (2 ** attempt) * (0.75 + 0.5 * self.jitter())
            try:
                wait = max(wait, min(float(retry_after), MAX_RETRY_AFTER_S)) if retry_after else wait
            except (TypeError, ValueError):
                pass
            await self.sleep(wait)
        return status, text

    async def get_text(self, url, host):
        """The `get(url, host)` that plan.prefetch expects: body text of a 2xx, else None."""
        status, text = await self.request("GET", url, host, {"User-Agent": UA, "Accept": "application/json"})
        return text if 200 <= status < 300 else None

    async def send_json(self, method, url, body, token, host="pipeline", tries=3):
        """PUT/POST a JSON body with the pipeline token (the observation archive, id cache and prune calls)."""
        import json
        headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA, "X-Pipeline-Token": token}
        status, text = await self.request(method, url, host, headers, json.dumps(body), tries=tries)
        return (json.loads(text) if 200 <= status < 300 and text else None), status


UA = "fishingconditions-pipeline/1.0 (+https://github.com/olivermestdagh-sys/fishingconditions)"


class NullNet:
    """The network client of the SHADOW Worker: it has no transport at all, so nothing in shadow mode can reach WillyWeather, Open-Meteo,
    the user Worker or anything else, even through a bug. Anything that tries gets an error that says so."""

    def __init__(self):
        import time
        self.stats = Stats()
        self.budgets = {}
        self.deadline = None
        self.clock = time.time

    async def request(self, *a, **k):
        raise RuntimeError("shadow mode makes no network requests")

    get_text = send_json = request

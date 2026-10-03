"""Minimal klient för api.swamp.se (Sensor Online)."""
from __future__ import annotations

import asyncio
import re
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote

import aiohttp

from .const import API_BASE, RAIN_KEY


class SwampAuthError(Exception):
    """Fel inloggning."""


class SwampApiError(Exception):
    """Övriga API-fel."""


_LEVEL_RE = re.compile(r"Level_Monitoring-Level", re.I)


def parse_local(value: str, tz) -> datetime | None:
    """API:t skickar lokal svensk tid utan tidszon: '2026-09-29 23:16:52' eller '2026-09-29T23:16:52'."""
    if not value:
        return None
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?", value)
    if not m:
        return None
    y, mo, d, h, mi, s = (int(x or 0) for x in m.groups())
    return datetime(y, mo, d, h, mi, s, tzinfo=tz)


def fmt_local(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


class SwampClient:
    """Loggar in med e-post/lösenord och hämtar data. Loggar in igen automatiskt när token gått ut."""

    def __init__(self, session: aiohttp.ClientSession, email: str, password: str) -> None:
        self._session = session
        self._email = email
        self._password = password
        self._token: str | None = None
        self._lock = asyncio.Lock()

    async def login(self) -> dict[str, Any]:
        try:
            async with self._session.post(
                API_BASE + "Users/authenticate",
                json={"email": self._email, "password": self._password},
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status in (400, 401, 403):
                    raise SwampAuthError("Fel e-post eller lösenord")
                if resp.status != 200:
                    raise SwampApiError(f"Inloggning misslyckades ({resp.status})")
                user = await resp.json(content_type=None)
        except aiohttp.ClientError as err:
            raise SwampApiError(f"Kan inte nå api.swamp.se: {err}") from err
        token = (user or {}).get("token")
        if not token:
            raise SwampAuthError("Inget token i svaret")
        self._token = token
        return user

    async def get(self, path: str) -> Any:
        async with self._lock:
            if not self._token:
                await self.login()
        for attempt in (1, 2):
            try:
                async with self._session.get(
                    API_BASE + path,
                    headers={"Authorization": f"Bearer {self._token}"},
                    timeout=aiohttp.ClientTimeout(total=60),
                ) as resp:
                    if resp.status == 401 and attempt == 1:
                        body = await resp.text()
                        if "permission" in body.lower():
                            raise SwampApiError(f"Behörighet saknas: {path}")
                        async with self._lock:
                            await self.login()
                        continue
                    if resp.status == 401:
                        raise SwampAuthError("Sessionen nekades")
                    if resp.status != 200:
                        raise SwampApiError(f"API {resp.status}: {path}")
                    return await resp.json(content_type=None)
            except aiohttp.ClientError as err:
                raise SwampApiError(f"Kan inte nå api.swamp.se: {err}") from err
        raise SwampApiError("Oväntat fel")

    async def discover(self) -> dict[str, list[dict[str, Any]]]:
        """Hitta regnmätare och nivåmätare (samma logik som skrivbordsappen)."""
        companies = await self.get("Companies/all")
        if not companies:
            raise SwampApiError("Inget företag kopplat till kontot")
        company_id = companies[0]["companyId"]
        tags = await self.get(f"Tag/company/{company_id}")
        dashboards = []
        try:
            dashboards = await self.get(f"companies/{company_id}/dashboards")
        except SwampApiError:
            pass

        async def latest(dev: str):
            try:
                return await self.get(f"TagData/simple/latest/all/{quote(dev, safe='')}")
            except SwampApiError:
                return []

        latests = await asyncio.gather(*(latest(t["deveui"]) for t in tags))
        gauges, levels = [], []
        for tag, keys in zip(tags, latests):
            keys = keys or []
            if any(k.get("key") == RAIN_KEY for k in keys):
                gauges.append({"id": tag["deveui"], "name": tag.get("name") or tag["deveui"],
                               "lat": tag.get("latitude"), "lon": tag.get("longitude")})
            lv = next((k for k in keys if _LEVEL_RE.search(k.get("key") or "")), None)
            if lv:
                levels.append({"id": tag["deveui"], "name": tag.get("name") or tag["deveui"], "key": lv["key"]})
        # Mätpunkt-namn från dashboards (typ 3)
        names: dict[str, str] = {}
        for d in [d for d in dashboards if d.get("type") == 3]:
            try:
                det = await self.get(f"Dashboards/{d['dashboardId']}")
            except SwampApiError:
                continue
            ids = [i.get("tagId") for i in (det.get("templateDashboardItems") or [])]
            for lv in levels:
                if lv["id"] in ids and lv["id"] not in names:
                    names[lv["id"]] = det.get("name") or d.get("name") or lv["id"]
        for lv in levels:
            if lv["id"] in names:
                lv["name"] = names[lv["id"]]
        gauges.sort(key=lambda g: g["name"])
        levels.sort(key=lambda l: l["name"])
        return {"company_id": company_id, "gauges": gauges, "levels": levels}

    async def latest_value(self, dev: str, key: str) -> tuple[float | None, str | None]:
        rows = await self.get(f"TagData/simple/latest/{quote(dev, safe='')}/{quote(key, safe='')}")
        if not rows:
            return None, None
        row = rows[0]
        try:
            return float(row.get("value")), row.get("createdAt")
        except (TypeError, ValueError):
            return None, row.get("createdAt")

    async def series(self, dev: str, key: str, start: datetime, end: datetime) -> list[tuple[datetime, float]]:
        path = (f"tagdata/timeseries/{quote(dev, safe='')}/{quote(key, safe='')}/"
                f"{quote(fmt_local(start), safe='')}/{quote(fmt_local(end), safe='')}")
        rows = await self.get(path) or []
        out = []
        for r in rows:
            t = parse_local(r.get("date") or r.get("createdAt") or "", start.tzinfo)
            try:
                v = float(r.get("value"))
            except (TypeError, ValueError):
                continue
            if t is not None:
                out.append((t, v))
        out.sort(key=lambda x: x[0])
        return out

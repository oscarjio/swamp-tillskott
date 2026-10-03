"""Datakoordinator: hämtar alla värden var 5:e minut."""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .api import SwampApiError, SwampAuthError, SwampClient, parse_local
from .const import CONF_GAUGES, CONF_LEVELS, DEFAULT_SCAN_MINUTES, DOMAIN, RAIN_KEY

_LOGGER = logging.getLogger(__name__)


def rain_stats(tips, now) -> dict[str, Any]:
    """Summera tippningar (0,2 mm st) till senaste timmen / idag / senaste 24 h."""
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    h1 = sum(v for t, v in tips if now - timedelta(hours=1) < t <= now)
    h24 = sum(v for t, v in tips if now - timedelta(hours=24) < t <= now)
    today = sum(v for t, v in tips if midnight <= t <= now)
    last = tips[-1][0] if tips else None
    return {"rain_1h": round(h1, 1), "rain_24h": round(h24, 1), "rain_today": round(today, 1), "last_rain": last}


class SwampCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, client: SwampClient) -> None:
        super().__init__(hass, _LOGGER, name=DOMAIN, update_interval=timedelta(minutes=DEFAULT_SCAN_MINUTES),
                         config_entry=entry)
        self.client = client
        self.entry = entry
        self.meta: dict[str, Any] = {}

    @property
    def gauges(self) -> list[dict[str, Any]]:
        wanted = self.entry.options.get(CONF_GAUGES, self.entry.data.get(CONF_GAUGES, []))
        return [g for g in self.meta.get("gauges", []) if g["id"] in wanted]

    @property
    def levels(self) -> list[dict[str, Any]]:
        wanted = self.entry.options.get(CONF_LEVELS, self.entry.data.get(CONF_LEVELS, []))
        return [l for l in self.meta.get("levels", []) if l["id"] in wanted]

    async def _async_update_data(self) -> dict[str, Any]:
        tz = dt_util.get_time_zone("Europe/Stockholm")  # API:t använder svensk lokaltid
        now = dt_util.now(tz)
        try:
            if not self.meta:
                self.meta = await self.client.discover()

            async def lvl(l):
                v, ts = await self.client.latest_value(l["id"], l["key"])
                return l["id"], {"level": v, "updated": parse_local(ts or "", tz)}

            async def rain(g):
                tips = await self.client.series(g["id"], RAIN_KEY, now - timedelta(hours=25), now)
                return g["id"], rain_stats(tips, now)

            results = await asyncio.gather(*(lvl(l) for l in self.levels), *(rain(g) for g in self.gauges))
        except SwampAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except SwampApiError as err:
            raise UpdateFailed(str(err)) from err
        return dict(results)

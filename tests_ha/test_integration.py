"""Tester mot ett mockat api.swamp.se."""
from datetime import timedelta
import re

import pytest
from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import async_fire_time_changed

from custom_components.swamp_sensor_online.const import DOMAIN

API = "https://api.swamp.se/api/"
TZ = dt_util.get_time_zone("Europe/Stockholm")


def fmt(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def mock_api(aioclient_mock, *, auth_ok=True, token="tok1"):
    if auth_ok:
        aioclient_mock.post(API + "Users/authenticate", json={"token": token, "tokenExpires": "2099-01-01", "email": "a@b.se"})
    else:
        aioclient_mock.post(API + "Users/authenticate", status=400, text="bad")
    aioclient_mock.get(API + "Companies/all", json=[{"companyId": 7, "name": "Ale kommun"}])
    aioclient_mock.get(API + "Tag/company/7", json=[
        {"deveui": "D0000OBB", "name": "D0000OBB"}, {"deveui": "D0000OBN", "name": "D0000OBN"},
        {"deveui": "YDOC_125717815", "name": "Nödinge"}, {"deveui": "YDOC_125717900", "name": "Bohus HR"}])
    aioclient_mock.get(API + "companies/7/dashboards", json=[{"dashboardId": 652, "name": "Mätpunkt 1", "type": 3}])
    aioclient_mock.get(API + "Dashboards/652", json={"name": "Mätpunkt 1", "templateDashboardItems": [{"tagId": "D0000OBB"}, {"tagId": "YDOC_125717815"}]})
    for d in ("D0000OBB", "D0000OBN"):
        aioclient_mock.get(API + f"TagData/simple/latest/all/{d}", json=[{"key": "Level_Monitoring-Level_200", "value": "1"}])
        aioclient_mock.get(API + f"TagData/simple/latest/{d}/Level_Monitoring-Level_200", json=[{"value": "147.677856" if d.endswith("BB") else "71.2", "createdAt": "2026-10-03T23:00:00"}])
    for d in ("YDOC_125717815", "YDOC_125717900"):
        aioclient_mock.get(API + f"TagData/simple/latest/all/{d}", json=[{"key": "RE", "value": "0.2"}])
    now = dt_util.now(TZ)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    tips = [now - timedelta(minutes=10), now - timedelta(minutes=20), now - timedelta(minutes=90)]
    if midnight - timedelta(hours=2) > now - timedelta(hours=24):
        tips.append(midnight - timedelta(hours=2))  # igår, inom 24 h
    rows = [{"date": fmt(t), "value": "0.2"} for t in tips]
    aioclient_mock.get(re.compile(r"https://api\.swamp\.se/api/tagdata/timeseries/YDOC_125717815/RE/.*"), json=rows)
    aioclient_mock.get(re.compile(r"https://api\.swamp\.se/api/tagdata/timeseries/YDOC_125717900/RE/.*"), json=[])
    return tips, midnight


async def _setup(hass, aioclient_mock):
    tips, midnight = mock_api(aioclient_mock)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] == "form" and result["step_id"] == "user"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"email": "a@b.se", "password": "x"})
    assert result["type"] == "form" and result["step_id"] == "select", result
    schema = result["data_schema"].schema
    defaults = {str(k): k.default() for k in schema}
    assert defaults["gauges"] == ["YDOC_125717815"], defaults  # Nödinge förvald
    assert set(defaults["levels"]) == {"D0000OBB", "D0000OBN"}
    result = await hass.config_entries.flow.async_configure(result["flow_id"], defaults)
    assert result["type"] == "create_entry", result
    await hass.async_block_till_done()
    return tips, midnight


async def test_full_setup(hass: HomeAssistant, aioclient_mock):
    await hass.config.async_update(time_zone="Europe/Stockholm")
    tips, midnight = await _setup(hass, aioclient_mock)
    states = {s.entity_id: s for s in hass.states.async_all("sensor")}
    print("\n" + "\n".join(f"{k} = {v.state} {v.attributes.get('unit_of_measurement','')} {dict((a,b) for a,b in v.attributes.items() if a in ('friendly_name','state_class','device_class'))}" for k, v in sorted(states.items())))
    lvl = [s for s in states.values() if s.attributes.get("friendly_name", "").endswith("Mätpunkt 1 Level") or "matpunkt_1" in s.entity_id]
    assert lvl and lvl[0].state == "147.677856"
    r1h = next(s for k, s in states.items() if k.endswith("rain_last_hour"))
    assert float(r1h.state) == 0.4
    r24 = next(s for k, s in states.items() if k.endswith("rain_last_24_h"))
    assert float(r24.state) == pytest.approx(0.2 * len(tips))
    today = next(s for k, s in states.items() if k.endswith("rain_today"))
    assert float(today.state) == pytest.approx(0.2 * sum(1 for t in tips if t >= midnight))
    assert today.attributes["state_class"] == "total_increasing"
    assert not any(k.startswith("sensor.swamp_bohus") for k in states)  # ej vald


async def test_bad_login(hass: HomeAssistant, aioclient_mock):
    mock_api(aioclient_mock, auth_ok=False)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"email": "a@b.se", "password": "fel"})
    assert result["type"] == "form" and result["errors"] == {"base": "invalid_auth"}


async def test_token_expiry_relogin_and_options(hass: HomeAssistant, aioclient_mock):
    await hass.config.async_update(time_zone="Europe/Stockholm")
    await _setup(hass, aioclient_mock)
    entry = hass.config_entries.async_entries(DOMAIN)[0]
    # enklare: gör en uppdatering och kontrollera att den lyckas
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(minutes=6))
    await hass.async_block_till_done()
    assert entry.state.value == "loaded"
    # options: lägg till Bohus HR
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] == "form"
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"gauges": ["YDOC_125717815", "YDOC_125717900"], "levels": ["D0000OBB"]})
    assert result["type"] == "create_entry"
    await hass.async_block_till_done()
    ids = [s.entity_id for s in hass.states.async_all("sensor")]
    assert any("bohus" in i for i in ids), ids
    print("\nefter options:", sorted(i for i in ids if hass.states.get(i).state != "unavailable"))


@pytest.mark.enable_socket
async def test_client_relogin_on_401(socket_enabled, aiohttp_server):
    """Token som gått ut (401) ska ge tyst ny inloggning och lyckat anrop."""
    from aiohttp import web, ClientSession
    from custom_components.swamp_sensor_online import api as api_mod
    state = {"logins": 0}
    async def auth(req):
        state["logins"] += 1
        return web.json_response({"token": f"t{state['logins']}"})
    async def data(req):
        if req.headers.get("Authorization") != "Bearer t2":
            return web.Response(status=401, text="expired")
        return web.json_response([{"value": "12.5", "createdAt": "2026-10-03T10:00:00"}])
    async def perm(req):
        return web.Response(status=401, text="You do not have the correct permissions")
    app = web.Application()
    app.router.add_post("/api/Users/authenticate", auth)
    app.router.add_get("/api/TagData/simple/latest/X/K", data)
    app.router.add_get("/api/Companies", perm)
    server = await aiohttp_server(app)
    api_mod.API_BASE = str(server.make_url("/api/"))
    async with ClientSession() as session:
        c = api_mod.SwampClient(session, "a", "b")
        v, ts = await c.latest_value("X", "K")
        assert v == 12.5 and state["logins"] == 2
        with pytest.raises(api_mod.SwampApiError, match="Behörighet"):
            await c.get("Companies")
        assert state["logins"] == 2  # behörighetsfel ska inte trigga ny inloggning

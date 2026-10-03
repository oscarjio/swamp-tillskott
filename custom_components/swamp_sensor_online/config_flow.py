"""Konfigurering via UI: logga in, välj regnmätare och nivåmätare."""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_EMAIL, CONF_PASSWORD
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .api import SwampApiError, SwampAuthError, SwampClient
from .const import CONF_GAUGES, CONF_LEVELS, DEFAULT_GAUGE_NAMES, DOMAIN

LOGIN_SCHEMA = vol.Schema({
    vol.Required(CONF_EMAIL): TextSelector(TextSelectorConfig(type=TextSelectorType.EMAIL, autocomplete="username")),
    vol.Required(CONF_PASSWORD): TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD, autocomplete="current-password")),
})


def _select_schema(meta: dict[str, Any], gauges: list[str], levels: list[str]) -> vol.Schema:
    def sel(items):
        return SelectSelector(SelectSelectorConfig(
            options=[SelectOptionDict(value=i["id"], label=f"{i['name']} ({i['id']})" if i["name"] != i["id"] else i["id"]) for i in items],
            multiple=True, mode=SelectSelectorMode.LIST))
    return vol.Schema({
        vol.Optional(CONF_GAUGES, default=gauges): sel(meta["gauges"]),
        vol.Optional(CONF_LEVELS, default=levels): sel(meta["levels"]),
    })


async def _login(hass, email, password):
    client = SwampClient(async_get_clientsession(hass), email, password)
    await client.login()
    return client, await client.discover()


class SwampConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._login: dict[str, Any] = {}
        self._meta: dict[str, Any] = {}

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                _, self._meta = await _login(self.hass, user_input[CONF_EMAIL], user_input[CONF_PASSWORD])
            except SwampAuthError:
                errors["base"] = "invalid_auth"
            except SwampApiError:
                errors["base"] = "cannot_connect"
            else:
                await self.async_set_unique_id(user_input[CONF_EMAIL].lower())
                self._abort_if_unique_id_configured()
                self._login = user_input
                return await self.async_step_select()
        return self.async_show_form(step_id="user", data_schema=self.add_suggested_values_to_schema(LOGIN_SCHEMA, user_input or {}), errors=errors)

    async def async_step_select(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title=f"Swamp ({self._login[CONF_EMAIL]})", data={**self._login, **user_input})
        gauges = [g["id"] for g in self._meta["gauges"] if g["name"] in DEFAULT_GAUGE_NAMES] or [g["id"] for g in self._meta["gauges"][:1]]
        levels = [l["id"] for l in self._meta["levels"]]
        return self.async_show_form(step_id="select", data_schema=_select_schema(self._meta, gauges, levels))

    async def async_step_reauth(self, entry_data: dict[str, Any]) -> ConfigFlowResult:
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        entry = self._get_reauth_entry()
        if user_input is not None:
            try:
                await _login(self.hass, entry.data[CONF_EMAIL], user_input[CONF_PASSWORD])
            except SwampAuthError:
                errors["base"] = "invalid_auth"
            except SwampApiError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_update_reload_and_abort(entry, data_updates={CONF_PASSWORD: user_input[CONF_PASSWORD]})
        return self.async_show_form(step_id="reauth_confirm", errors=errors,
                                    data_schema=vol.Schema({vol.Required(CONF_PASSWORD): TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))}))

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return SwampOptionsFlow()


class SwampOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        meta = self.config_entry.runtime_data.meta
        cur_g = self.config_entry.options.get(CONF_GAUGES, self.config_entry.data.get(CONF_GAUGES, []))
        cur_l = self.config_entry.options.get(CONF_LEVELS, self.config_entry.data.get(CONF_LEVELS, []))
        return self.async_show_form(step_id="init", data_schema=_select_schema(meta, cur_g, cur_l))

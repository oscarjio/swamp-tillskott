"""Sensorer: nivå per mätpunkt och regn per regnmätare."""
from __future__ import annotations

from dataclasses import dataclass

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfLength, UnitOfPrecipitationDepth
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import SwampCoordinator


@dataclass(frozen=True, kw_only=True)
class SwampSensorDescription(SensorEntityDescription):
    field: str


RAIN_SENSORS = (
    SwampSensorDescription(key="rain_1h", field="rain_1h", translation_key="rain_1h",
                           native_unit_of_measurement=UnitOfPrecipitationDepth.MILLIMETERS,
                           device_class=SensorDeviceClass.PRECIPITATION, state_class=SensorStateClass.MEASUREMENT,
                           suggested_display_precision=1),
    SwampSensorDescription(key="rain_today", field="rain_today", translation_key="rain_today",
                           native_unit_of_measurement=UnitOfPrecipitationDepth.MILLIMETERS,
                           device_class=SensorDeviceClass.PRECIPITATION, state_class=SensorStateClass.TOTAL_INCREASING,
                           suggested_display_precision=1),
    SwampSensorDescription(key="rain_24h", field="rain_24h", translation_key="rain_24h",
                           native_unit_of_measurement=UnitOfPrecipitationDepth.MILLIMETERS,
                           device_class=SensorDeviceClass.PRECIPITATION, state_class=SensorStateClass.MEASUREMENT,
                           suggested_display_precision=1),
    SwampSensorDescription(key="last_rain", field="last_rain", translation_key="last_rain",
                           device_class=SensorDeviceClass.TIMESTAMP),
)
LEVEL_SENSOR = SwampSensorDescription(key="level", field="level", translation_key="level",
                                      native_unit_of_measurement=UnitOfLength.MILLIMETERS,
                                      device_class=SensorDeviceClass.DISTANCE, state_class=SensorStateClass.MEASUREMENT,
                                      suggested_display_precision=0, icon="mdi:waves-arrow-up")


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator: SwampCoordinator = entry.runtime_data
    entities: list[SwampSensor] = []
    for lv in coordinator.levels:
        entities.append(SwampSensor(coordinator, lv["id"], lv["name"], "Nivåmätare", LEVEL_SENSOR))
    for g in coordinator.gauges:
        entities.extend(SwampSensor(coordinator, g["id"], g["name"], "Regnmätare", d) for d in RAIN_SENSORS)
    async_add_entities(entities)


class SwampSensor(CoordinatorEntity[SwampCoordinator], SensorEntity):
    _attr_has_entity_name = True
    entity_description: SwampSensorDescription

    def __init__(self, coordinator, dev_id, dev_name, model, description) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        self._dev = dev_id
        self._attr_unique_id = f"{dev_id}_{description.key}"
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, dev_id)}, name=f"Swamp {dev_name}",
                                            manufacturer="Swamp / Sensor Online", model=model, serial_number=dev_id)

    @property
    def _row(self) -> dict:
        return (self.coordinator.data or {}).get(self._dev) or {}

    @property
    def available(self) -> bool:
        return super().available and self.entity_description.field in self._row

    @property
    def native_value(self):
        return self._row.get(self.entity_description.field)

    @property
    def extra_state_attributes(self):
        if self.entity_description.key == "level" and self._row.get("updated"):
            return {"mätvärde_tid": self._row["updated"].isoformat()}
        return None

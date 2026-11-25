"""Sync server tests. Phone numbers come only from reserved fictional ranges:
UK drama numbers +44 7700 900000-900999 and North American +1 <area> 555 0100-0199.
"""

from __future__ import annotations

import pytest
from starlette.websockets import WebSocketDisconnect

from conftest import ADMIN, DEVICE

UK_A = "+447700900417"
UK_B = "+447700900418"
US_A = "+12025550142"
AUTH = {"Authorization": f"Bearer {ADMIN}"}


def enc(phone: str) -> str:
    return phone.replace("+", "%2B")


def numbers(client, headers=None) -> list[str]:
    return client.get("/api/v1/snapshot", headers=headers or {}).json()["numbers"]


def version(client) -> int:
    return client.get("/healthz").json()["version"]


# ------------------------------------------------------------------ flagging


def test_flag_then_upsert_keeps_label_and_source(client):
    r = client.post("/api/v1/scammers", json={"phone": "+44 7700 900417", "label": "@fake_parcel",
                                              "note": "first report", "source": "mirsad-test"})
    assert r.status_code == 200
    row = r.json()
    assert (row["phone"], row["active"], row["label"], row["source"]) == (UK_A, 1, "@fake_parcel", "mirsad-test")

    r = client.post("/api/v1/scammers", json={"phone": UK_A, "note": "second report"})
    row = r.json()
    assert row["label"] == "@fake_parcel" and row["source"] == "mirsad-test" and row["note"] == "second report"
    assert numbers(client) == [UK_A]


def test_flag_inactive_is_kept_but_not_pushed(client):
    client.post("/api/v1/scammers", json={"phone": UK_A, "active": False})
    assert numbers(client) == []
    assert [s["phone"] for s in client.get("/api/v1/scammers").json()["scammers"]] == [UK_A]


def test_patch_active_switches_number_off_and_on(client):
    client.post("/api/v1/scammers", json={"phone": UK_A})
    assert client.patch(f"/api/v1/scammers/{enc(UK_A)}", json={"active": False}).json()["active"] == 0
    assert numbers(client) == []
    assert client.patch(f"/api/v1/scammers/{enc(UK_A)}", json={"active": True}).json()["active"] == 1
    assert numbers(client) == [UK_A]


def test_patch_unknown_number_is_404(client):
    assert client.patch(f"/api/v1/scammers/{enc(UK_A)}", json={"active": False}).status_code == 404


def test_toggle_creates_then_flips(client):
    row = client.post(f"/api/v1/scammers/{enc(UK_A)}/toggle").json()
    assert (row["active"], row["source"]) == (1, "toggle")
    assert client.post(f"/api/v1/scammers/{enc(UK_A)}/toggle").json()["active"] == 0
    assert client.post(f"/api/v1/scammers/{enc(UK_A)}/toggle").json()["active"] == 1


def test_delete_removes_and_second_delete_is_404(client):
    client.post("/api/v1/scammers", json={"phone": UK_A})
    r = client.delete(f"/api/v1/scammers/{enc(UK_A)}")
    assert r.status_code == 200 and r.json()["deleted"] == UK_A
    assert numbers(client) == []
    assert client.delete(f"/api/v1/scammers/{enc(UK_A)}").status_code == 404


def test_bulk_dedupes_normalises_and_reactivates(client):
    client.post("/api/v1/scammers", json={"phone": UK_B, "active": False})
    r = client.post("/api/v1/scammers/bulk",
                    json={"phones": [UK_A, "+44 7700 900417", "0044 7700 900418", US_A], "source": "import"})
    assert r.json()["added_or_activated"] == 3
    assert sorted(numbers(client)) == sorted([UK_A, UK_B, US_A])


def test_bulk_rejects_whole_request_on_bad_number(client):
    r = client.post("/api/v1/scammers/bulk", json={"phones": [UK_A, "not a number"]})
    assert r.status_code == 422
    assert numbers(client) == []


# ------------------------------------------------------------- normalisation


@pytest.mark.parametrize("raw", ["+44 7700 900417", "+44-7700-900417", "0044 7700 900417", "+44 (0)7700 900417"])
def test_international_forms_normalise_to_e164(client, raw):
    assert client.post("/api/v1/scammers", json={"phone": raw}).json()["phone"] == UK_A


def test_north_american_fictional_range(client):
    assert client.post("/api/v1/scammers", json={"phone": "+1 (202) 555-0142"}).json()["phone"] == US_A


def test_local_number_without_default_region_is_rejected(client):
    r = client.post("/api/v1/scammers", json={"phone": "07700 900417"})
    assert r.status_code == 422
    assert "SCAMSHIELD_DEFAULT_REGION" in r.json()["detail"]


def test_local_number_uses_default_region(make_client):
    c = make_client(region="GB")
    assert c.post("/api/v1/scammers", json={"phone": "07700 900417"}).json()["phone"] == UK_A
    assert c.post("/api/v1/scammers", json={"phone": "+1 202 555 0142"}).json()["phone"] == US_A


@pytest.mark.parametrize("raw", ["", "hello", "+44 77"])
def test_impossible_numbers_are_rejected(client, raw):
    assert client.post("/api/v1/scammers", json={"phone": raw}).status_code == 422


def test_path_number_is_normalised_too(client):
    client.post("/api/v1/scammers", json={"phone": UK_A})
    assert client.patch("/api/v1/scammers/0044%207700%20900417", json={"active": False}).json()["phone"] == UK_A


# ---------------------------------------------------------------------- auth


def test_open_mode_needs_no_tokens(client):
    assert client.post("/api/v1/scammers", json={"phone": UK_A}).status_code == 200
    assert client.get("/api/v1/scammers").status_code == 200
    assert client.get("/api/v1/snapshot").status_code == 200


def test_admin_token_is_enforced_on_every_write_and_list(make_client):
    c = make_client(admin=ADMIN, device=DEVICE)
    calls = [
        ("post", "/api/v1/scammers", {"phone": UK_A}),
        ("post", "/api/v1/scammers/bulk", {"phones": [UK_A]}),
        ("patch", f"/api/v1/scammers/{enc(UK_A)}", {"active": False}),
        ("post", f"/api/v1/scammers/{enc(UK_A)}/toggle", None),
        ("delete", f"/api/v1/scammers/{enc(UK_A)}", None),
        ("get", "/api/v1/scammers", None),
    ]
    for method, path, body in calls:
        kwargs = {"json": body} if body is not None else {}
        for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": f"Bearer {DEVICE}"}):
            r = c.request(method, path, headers=headers, **kwargs)
            assert r.status_code == 401, (method, path, headers)
    assert c.post("/api/v1/scammers", json={"phone": UK_A}, headers=AUTH).status_code == 200
    assert c.get("/api/v1/scammers", headers=AUTH).json()["scammers"][0]["phone"] == UK_A


def test_device_token_is_enforced_on_snapshot(make_client):
    c = make_client(admin=ADMIN, device=DEVICE)
    assert c.get("/api/v1/snapshot").status_code == 401
    assert c.get("/api/v1/snapshot", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert c.get("/api/v1/snapshot", headers={"Authorization": f"Bearer {DEVICE}"}).status_code == 200
    assert c.get("/api/v1/snapshot", headers=AUTH).status_code == 200


def test_non_ascii_token_is_rejected_not_a_server_error(make_client):
    c = make_client(admin=ADMIN, device=DEVICE)
    assert c.get("/api/v1/snapshot", headers={"Authorization": "Bearer t\xe9st".encode("latin-1")}).status_code == 401
    with pytest.raises(WebSocketDisconnect) as e, c.websocket_connect("/api/v1/ws?token=%C3%A9"):
        pass
    assert e.value.code == 4401


@pytest.mark.parametrize("url,headers", [
    ("/api/v1/ws", {}),
    ("/api/v1/ws?token=wrong", {}),
    ("/api/v1/ws", {"Authorization": "Bearer wrong"}),
])
def test_device_token_is_enforced_on_websocket(make_client, url, headers):
    c = make_client(admin=ADMIN, device=DEVICE)
    with pytest.raises(WebSocketDisconnect) as e, c.websocket_connect(url, headers=headers):
        pass
    assert e.value.code == 4401


@pytest.mark.parametrize("url,headers", [
    (f"/api/v1/ws?token={DEVICE}", {}),
    ("/api/v1/ws", {"Authorization": f"Bearer {DEVICE}"}),
    (f"/api/v1/ws?token={ADMIN}", {}),
])
def test_websocket_accepts_device_or_admin_token(make_client, url, headers):
    c = make_client(admin=ADMIN, device=DEVICE)
    with c.websocket_connect(url, headers=headers) as ws:
        assert ws.receive_json()["type"] == "snapshot"


# ------------------------------------------------------------ live push + version


def test_websocket_gets_snapshot_on_connect_and_after_each_change(client):
    client.post("/api/v1/scammers", json={"phone": UK_A})
    with client.websocket_connect("/api/v1/ws") as ws:
        first = ws.receive_json()
        assert first == {"type": "snapshot", "version": first["version"],
                         "contact_name": "⚠️ Known Scammer", "numbers": [UK_A]}

        client.post("/api/v1/scammers", json={"phone": US_A})
        second = ws.receive_json()
        assert second["numbers"] == [UK_A, US_A] and second["version"] == first["version"] + 1

        client.patch(f"/api/v1/scammers/{enc(UK_A)}", json={"active": False})
        third = ws.receive_json()
        assert third["numbers"] == [US_A] and third["version"] == second["version"] + 1

        client.delete(f"/api/v1/scammers/{enc(US_A)}")
        assert ws.receive_json()["numbers"] == []


def test_contact_name_is_configurable(make_client):
    c = make_client(contact_name="⚠️ محتال معروف")
    assert c.get("/api/v1/snapshot").json()["contact_name"] == "⚠️ محتال معروف"


def test_every_write_increments_version(client):
    v = version(client)
    client.post("/api/v1/scammers", json={"phone": UK_A})
    client.post(f"/api/v1/scammers/{enc(UK_A)}/toggle")
    client.patch(f"/api/v1/scammers/{enc(UK_A)}", json={"active": True})
    client.post("/api/v1/scammers/bulk", json={"phones": [UK_B]})
    client.delete(f"/api/v1/scammers/{enc(UK_A)}")
    assert version(client) == v + 5
    assert client.get("/api/v1/snapshot").json()["version"] == v + 5


def test_failed_write_does_not_increment_version(client):
    v = version(client)
    client.post("/api/v1/scammers", json={"phone": "hello"})
    client.delete(f"/api/v1/scammers/{enc(UK_A)}")
    assert version(client) == v


def test_healthz_counts_phones_not_dashboards(client):
    with client.websocket_connect("/api/v1/ws?role=dashboard") as dash:
        dash.receive_json()
        with client.websocket_connect("/api/v1/ws") as phone:
            phone.receive_json()
            assert client.get("/healthz").json()["devices_connected"] == 1

import asyncio
import os
from pathlib import Path
from types import SimpleNamespace

import httpx

from app.providers import xhs_login
from app.providers.errors import UpstreamError
from app.providers.xhs_session import load_session, save_session, session_file, session_root


def test_platform_rejection_is_reported_without_waiting_for_qr_or_echoing_redirect_data():
    message = xhs_login._login_rejection('https://www.xiaohongshu.com/website-login/error?error_code=300012&uuid=private-fixture')
    assert '300012' in message
    assert 'private-fixture' not in message
    assert xhs_login._login_rejection('https://www.xiaohongshu.com/explore') is None


def test_session_is_encrypted_at_rest_and_round_trips(monkeypatch, tmp_path):
    monkeypatch.setenv('XHS_SESSION_FILE', str(tmp_path / 'state' / 'session.enc'))
    cookie = 'web_session=fixture-cookie'
    save_session(cookie, 'fixture-browser')

    assert cookie.encode() not in session_file().read_bytes()
    assert load_session() == {'cookie': cookie, 'user_agent': 'fixture-browser'}
    assert (session_root() / 'session.key').is_file()
    if os.name != 'nt':
        assert session_file().stat().st_mode & 0o777 == 0o600
        assert (session_root() / 'session.key').stat().st_mode & 0o777 == 0o600


def test_login_status_requires_real_session_verification(monkeypatch, tmp_path):
    monkeypatch.setenv('XHS_SESSION_FILE', str(tmp_path / 'session.enc'))
    save_session('web_session=fixture-cookie', 'fixture-browser')
    calls = []

    async def verified(client, session):
        calls.append(session)

    monkeypatch.setattr(xhs_login, 'verify_session', verified)
    manager = xhs_login.XhsLoginManager()

    async def run():
        async with httpx.AsyncClient() as client:
            return await manager.status(client)

    state = asyncio.run(run())
    assert state == {'status': 'logged_in', 'message': '小红书登录状态已通过真实接口验证'}
    assert calls == [{'cookie': 'web_session=fixture-cookie', 'user_agent': 'fixture-browser'}]
    assert 'fixture-cookie' not in str(state)


def test_selfinfo_verification_requires_a_non_guest_identity(monkeypatch):
    monkeypatch.setattr('xhshow.Xhshow', lambda: SimpleNamespace(sign_headers_get=lambda **kwargs: {'x-s': 'fixture-signature'}))

    async def run(payload):
        calls = []

        def handle(request):
            calls.append(request)
            assert request.method == 'GET'
            assert request.url.path.endswith('/api/sns/web/v1/user/selfinfo')
            assert request.headers['cookie'] == 'web_session=fixture-cookie'
            return httpx.Response(200, json=payload)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            try:
                await xhs_login.verify_session(client, {'cookie': 'web_session=fixture-cookie', 'user_agent': 'fixture-agent'})
            except UpstreamError as error:
                return error, calls
            return None, calls

    verified, calls = asyncio.run(run({'success': True, 'data': {'user_id': 'account-id-fixture'}}))
    assert verified is None
    assert len(calls) == 1

    with_guest = {'success': True, 'data': {'user_id': 'guest'}}
    with_guest_identity = asyncio.run(run(with_guest))
    assert with_guest_identity[0].code == 'XHS_USER_ACTION_REQUIRED'
    assert 'guest' not in with_guest_identity[0].message
    explicit_guest = asyncio.run(run({'success': True, 'data': {'user_id': 'anonymous-id-fixture', 'guest': True}}))
    assert explicit_guest[0].code == 'XHS_USER_ACTION_REQUIRED'


def test_login_start_and_logout_use_only_user_facing_state(monkeypatch, tmp_path):
    monkeypatch.setenv('XHS_SESSION_FILE', str(tmp_path / 'session.enc'))
    monkeypatch.setenv('XHS_ACCESS_DB', str(tmp_path / 'xhs-access.sqlite'))
    monkeypatch.setattr(xhs_login, 'has_session', lambda: False)
    manager = xhs_login.XhsLoginManager()
    entered = asyncio.Event()

    async def fake_flow(self, client):
        self._state = {'status': 'waiting_scan', 'message': '请扫描', 'qr_image': 'data:image/png;base64,fixture'}
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(xhs_login.XhsLoginManager, '_login_flow', fake_flow)

    async def run():
        async with httpx.AsyncClient() as client:
            started = await manager.start(client)
            await entered.wait()
            waiting = manager.snapshot()
            logged_out = await manager.logout()
        return started, waiting, logged_out

    started, waiting, logged_out = asyncio.run(run())
    assert started['status'] == 'starting'
    assert waiting['status'] == 'waiting_scan'
    assert waiting['qr_image'].startswith('data:image/png;base64,')
    assert 'cookie' not in str(waiting).lower()
    assert logged_out['status'] == 'not_logged_in'


def test_terminal_error_survives_status_poll_until_logout(monkeypatch, tmp_path):
    monkeypatch.setenv('XHS_SESSION_FILE', str(tmp_path / 'session.enc'))
    monkeypatch.setenv('XHS_ACCESS_DB', str(tmp_path / 'xhs-access.sqlite'))
    monkeypatch.setattr(xhs_login, 'has_session', lambda: False)
    manager = xhs_login.XhsLoginManager()
    manager._state = {'status': 'error', 'message': '二维码登录等待超时，请重新开始'}

    async def run():
        async with httpx.AsyncClient() as client:
            statuses = []
            for value in ('error', 'expired', 'requires_verification'):
                manager._state = {'status': value, 'message': value}
                statuses.append(await manager.status(client))
            logged_out = await manager.logout()
        return statuses, logged_out

    statuses, logged_out = asyncio.run(run())
    assert [state['status'] for state in statuses] == ['error', 'expired', 'requires_verification']
    assert logged_out['status'] == 'not_logged_in'


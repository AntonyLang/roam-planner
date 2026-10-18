"""User-driven XHS QR login and real session verification."""
from __future__ import annotations

import asyncio
import base64
import os
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx

from .errors import UpstreamError
from .xhs_api import XhsApi
from .xhs_session import delete_session, has_session, load_session, save_session
from ..runtime_config import get_effective_config


class XhsLoginManager:
    def __init__(self):
        self._state = {'status': 'not_logged_in', 'message': '尚未登录小红书'}
        self._task: asyncio.Task | None = None
        self._last_check = 0.0
        self._check_lock = asyncio.Lock()

    def snapshot(self) -> dict:
        result = {'status': self._state['status'], 'message': self._state['message']}
        if self._state.get('qr_image'):
            result['qr_image'] = self._state['qr_image']
        return result

    async def status(self, client: httpx.AsyncClient) -> dict:
        if self._task and not self._task.done():
            return self.snapshot()
        if self._state['status'] in ('error', 'expired', 'requires_verification'):
            return self.snapshot()
        if not has_session():
            self._state = {'status': 'not_logged_in', 'message': '尚未登录小红书'}
            return self.snapshot()
        if time.monotonic() - self._last_check < 30:
            return self.snapshot()
        async with self._check_lock:
            if time.monotonic() - self._last_check < 30:
                return self.snapshot()
            self._last_check = time.monotonic()
            try:
                await verify_session(client, load_session())
            except UpstreamError as error:
                statuses = {
                    'XHS_SESSION_EXPIRED': ('expired', '登录状态已失效，请重新扫码'),
                    'XHS_USER_ACTION_REQUIRED': ('requires_verification', '小红书要求完成验证，请在小红书端处理后重新检查'),
                }
                status, message = statuses.get(error.code, ('error', error.message))
                self._state = {'status': status, 'message': message}
            except (OSError, ValueError):
                self._state = {'status': 'error', 'message': '无法读取或解密小红书登录状态'}
            except httpx.HTTPError:
                self._state = {'status': 'error', 'message': '无法连接小红书以验证登录状态'}
            else:
                self._state = {'status': 'logged_in', 'message': '小红书登录状态已通过真实接口验证'}
                self._last_check = time.monotonic()
            return self.snapshot()

    async def start(self, client: httpx.AsyncClient) -> dict:
        if self._task and not self._task.done():
            if self._state['status'] not in ('error', 'expired'):
                return self.snapshot()
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        if has_session():
            current = await self.status(client)
            if current['status'] == 'logged_in':
                return current
        self._state = {'status': 'starting', 'message': '正在打开小红书二维码登录页'}
        self._task = asyncio.create_task(self._login_flow(client), name='xhs-qr-login')
        return self.snapshot()

    async def logout(self) -> dict:
        if self._task and not self._task.done():
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        delete_session()
        database = Path(os.getenv('XHS_ACCESS_DB', '/data/crawled/xhs-access.sqlite'))
        database.unlink(missing_ok=True)
        self._last_check = 0.0
        self._state = {'status': 'not_logged_in', 'message': '已退出小红书并清除本地登录状态'}
        return self.snapshot()

    async def _login_flow(self, client: httpx.AsyncClient) -> None:
        phase = 'browser'
        try:
            from playwright.async_api import async_playwright

            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch(headless=True, args=['--no-sandbox'])
                context = await browser.new_context()
                try:
                    page = await context.new_page()
                    phase = 'page'
                    await page.goto('https://www.xiaohongshu.com/explore', wait_until='domcontentloaded', timeout=45000)
                    deadline = time.monotonic() + int(os.getenv('XHS_LOGIN_TIMEOUT_SECONDS', '600'))
                    qr_deadline = time.monotonic() + 30
                    last_dialog_attempt = 0.0
                    attempted_cookie = None
                    last_verify_attempt = 0.0
                    last_qr_capture = 0.0
                    while time.monotonic() < deadline:
                        if not (await get_effective_config(client)).xhs.enabled:
                            self._state = {'status': 'not_logged_in', 'message': '小红书来源已停用，已停止等待登录'}
                            return
                        if page.is_closed():
                            self._state = {'status': 'error', 'message': '登录页面已关闭，请重新开始'}
                            return
                        rejection = _login_rejection(page.url)
                        if rejection:
                            self._state = {'status': 'error', 'message': rejection}
                            return
                        if self._state['status'] == 'starting' and time.monotonic() > qr_deadline:
                            self._state = {'status': 'error', 'message': '小红书未能显示二维码，请稍后按平台提示重试'}
                            return
                        if time.monotonic() - last_dialog_attempt > 5:
                            await _open_login_dialog(page)
                            last_dialog_attempt = time.monotonic()
                        if time.monotonic() - last_qr_capture > 5:
                            image = await _qr_image(page)
                            if image:
                                if self._state['status'] in ('starting', 'waiting_scan'):
                                    self._state = {'status': 'waiting_scan', 'message': '请用小红书扫描二维码并在手机上确认', 'qr_image': image}
                                else:
                                    self._state['qr_image'] = image
                            last_qr_capture = time.monotonic()
                        cookies = await context.cookies(['https://www.xiaohongshu.com'])
                        cookie = '; '.join(item['name'] + '=' + item['value'] for item in cookies if item.get('name') and item.get('value'))
                        should_verify = cookie != attempted_cookie or (
                            self._state['status'] == 'requires_verification' and time.monotonic() - last_verify_attempt > 30
                        )
                        if cookie and should_verify and any(item.get('name') == 'web_session' and item.get('value') for item in cookies):
                            attempted_cookie = cookie
                            last_verify_attempt = time.monotonic()
                            user_agent = await page.evaluate('navigator.userAgent')
                            try:
                                await verify_session(client, {'cookie': cookie, 'user_agent': user_agent})
                            except UpstreamError as error:
                                if error.code == 'XHS_SESSION_EXPIRED':
                                    self._state = {'status': 'expired', 'message': '小红书登录状态未生效，请重新扫码'}
                                elif error.code == 'XHS_USER_ACTION_REQUIRED':
                                    self._state = {'status': 'requires_verification', 'message': '小红书要求完成验证，请在手机端确认后继续'}
                                else:
                                    self._state = {'status': 'error', 'message': error.message}
                            except (httpx.HTTPError, ValueError):
                                self._state = {'status': 'error', 'message': '小红书登录状态验证失败，请重试'}
                            else:
                                save_session(cookie, user_agent)
                                self._last_check = time.monotonic()
                                self._state = {'status': 'logged_in', 'message': '小红书登录成功，登录状态已通过真实接口验证'}
                                return
                        await asyncio.sleep(1)
                    self._state = {'status': 'error', 'message': '二维码登录等待超时，请重新开始'}
                finally:
                    await context.close()
                    await browser.close()
        except asyncio.CancelledError:
            raise
        except Exception:
            self._state = {'status': 'error', 'message': '无法启动小红书登录浏览器，请检查 Chromium 服务配置' if phase == 'browser'
                           else '无法打开小红书登录页，请检查 Sources 容器网络后重试'}


def _login_rejection(url: str) -> str | None:
    parsed = urlparse(url)
    if parsed.path != '/website-login/error':
        return None
    code = parse_qs(parsed.query).get('error_code', [''])[0]
    suffix = f'（{code}）' if code.isdigit() and len(code) <= 12 else ''
    return f'小红书拒绝了当前网络访问{suffix}，未生成二维码；请按平台提示处理后重试'


async def verify_session(client: httpx.AsyncClient, session: dict | None) -> None:
    if not session:
        raise UpstreamError('XHS_SESSION_EXPIRED', '小红书登录状态不存在')
    api = XhsApi(client, session)
    data = await api.self_info()
    nested = data.get('result') if isinstance(data.get('result'), dict) else {}
    scopes = [data, nested]
    if any(scope.get('guest') is True or scope.get('is_guest') is True for scope in scopes):
        raise UpstreamError('XHS_USER_ACTION_REQUIRED', '小红书当前返回访客身份，请重新扫码')
    candidates = []
    for scope in scopes:
        candidates.extend(scope.get(name) for name in ('user_id', 'userid', 'userId', 'id'))
        user = scope.get('user')
        if isinstance(user, dict):
            candidates.extend(user.get(name) for name in ('user_id', 'userid', 'userId', 'id'))
        elif isinstance(user, (str, int)):
            candidates.append(user)
    identities = [str(value).strip().casefold() for value in candidates
                  if isinstance(value, (str, int)) and not isinstance(value, bool) and str(value).strip()]
    guest_ids = {'0', 'guest', 'anonymous', 'visitor', 'none', 'null', 'undefined'}
    if not any(value not in guest_ids and not value.startswith('guest_') for value in identities):
        raise UpstreamError('XHS_USER_ACTION_REQUIRED', '小红书未返回已认证的非访客身份')


async def _open_login_dialog(page) -> None:
    dialog = page.locator('.login-container, .login-modal, [role="dialog"]')
    if await dialog.count() and await dialog.first.is_visible():
        return
    controls = [
        page.get_by_role('button', name='登录', exact=True),
        page.get_by_text('登录探索更多内容', exact=True),
        page.get_by_text('登录', exact=True),
    ]
    for control in controls:
        if await control.count() and await control.first.is_visible():
            try:
                await control.first.click(timeout=3000)
                return
            except Exception:
                continue


async def _qr_image(page) -> str | None:
    qr = page.locator('.login-container img.qrcode-img, .login-modal img.qrcode-img')
    if not await qr.count() or not await qr.first.is_visible():
        return None
    image = await qr.first.screenshot()
    return 'data:image/png;base64,' + base64.b64encode(image).decode('ascii')


login_manager = XhsLoginManager()

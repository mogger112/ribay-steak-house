<?php
// Серверная часть панели владельца. Работает на обычном PHP-хостинге (PHP 7.4 и новее).
// Меню лежит в data/menu.csv, загруженные фото — в assets/img/uploads/.
// Код владельца хранится в config.php (его нет в публичном репозитории).
//
// Что умеет этот файл: войти по коду, прочитать меню, сохранить меню, загрузить фото-JPEG. Больше ничего.

error_reporting(0);
ini_set('display_errors', '0');

const MENU_FILE = __DIR__ . '/data/menu.csv';
const UPLOAD_DIR = __DIR__ . '/assets/img/uploads';
const UPLOAD_URL = 'assets/img/uploads';
const CONFIG_FILE = __DIR__ . '/config.php';
const STORAGE = __DIR__ . '/storage';
const RATE_FILE = STORAGE . '/rate.json';
const LOCK_FILE = STORAGE . '/menu.lock';
const CSV_HEADER = 'Категория,Название,Цена,Фото,Показывать';
const SESSION_NAME = 'ribay_owner';
const SESSION_SECONDS = 2592000;   // 30 дней
const FAIL_WINDOW = 900;           // 15 минут
const MAX_IP_FAILS = 5;
const MAX_ALL_FAILS = 40;
const MAX_BODY = 3000000;
const MAX_CSV_CHARS = 100000;
const MAX_CSV_LINES = 600;
const MAX_PHOTO_BYTES = 1500000;
const MAX_PHOTO_SIDE = 4000;
const MAX_UPLOADS = 500;
const MAX_BACKUPS = 40;
const PLACEHOLDER_CODE = 'ЗАМЕНИТЕ_НА_СВОЙ_КОД';

// ---------- ответы ----------
function respond(array $data, int $status = 200)
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $code, int $status)
{
    respond(['error' => $code], $status);
}

function read_json(): array
{
    $type = isset($_SERVER['CONTENT_TYPE']) ? (string)$_SERVER['CONTENT_TYPE'] : '';
    if (stripos($type, 'application/json') !== 0) {
        fail('bad-request', 415);
    }
    $raw = file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
    if ($raw === false || strlen($raw) > MAX_BODY) {
        fail('too-large', 413);
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        fail('bad-request', 400);
    }
    return $data;
}

// ---------- служебная папка (сессии, копии меню, счётчик попыток) ----------
function ensure_storage()
{
    foreach ([STORAGE, STORAGE . '/sessions', STORAGE . '/backups'] as $dir) {
        if (!is_dir($dir)) {
            @mkdir($dir, 0700, true);
        }
    }
    $ht = STORAGE . '/.htaccess';
    if (!is_file($ht)) {
        @file_put_contents($ht, "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nOrder allow,deny\nDeny from all\n</IfModule>\n");
    }
    $ix = STORAGE . '/index.html';
    if (!is_file($ix)) {
        @file_put_contents($ix, '');
    }
    if (!is_dir(STORAGE . '/sessions') || !is_writable(STORAGE . '/sessions')) {
        fail('write-failed', 500);
    }
}

// ---------- ограничение попыток входа ----------
function client_ip(): string
{
    $ip = isset($_SERVER['REMOTE_ADDR']) ? (string)$_SERVER['REMOTE_ADDR'] : 'unknown';
    $ip = preg_replace('/[^0-9a-fA-F:.]/', '', $ip);
    return $ip === '' ? 'unknown' : substr($ip, 0, 45);
}

function rate_load($fh, int $now): array
{
    rewind($fh);
    $raw = stream_get_contents($fh);
    $data = json_decode(($raw === false || $raw === '') ? '[]' : $raw, true);
    $out = [];
    if (is_array($data)) {
        foreach ($data as $key => $list) {
            if (!is_array($list)) {
                continue;
            }
            $keep = [];
            foreach ($list as $t) {
                if (is_int($t) && $t > $now - FAIL_WINDOW) {
                    $keep[] = $t;
                }
            }
            if ($keep) {
                $out[$key] = array_slice($keep, -100);
            }
        }
    }
    return $out;
}

function rate_store($fh, array $data)
{
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($data));
    fflush($fh);
}

function rate_blocked(string $ip): bool
{
    $fh = @fopen(RATE_FILE, 'c+');
    if (!$fh) {
        return false;
    }
    flock($fh, LOCK_EX);
    $data = rate_load($fh, time());
    flock($fh, LOCK_UN);
    fclose($fh);
    $ipCount = isset($data['ip:' . $ip]) ? count($data['ip:' . $ip]) : 0;
    $allCount = isset($data['all']) ? count($data['all']) : 0;
    return $ipCount >= MAX_IP_FAILS || $allCount >= MAX_ALL_FAILS;
}

function rate_fail(string $ip)
{
    $fh = @fopen(RATE_FILE, 'c+');
    if (!$fh) {
        return;
    }
    flock($fh, LOCK_EX);
    $now = time();
    $data = rate_load($fh, $now);
    $data['ip:' . $ip][] = $now;
    $data['all'][] = $now;
    rate_store($fh, $data);
    flock($fh, LOCK_UN);
    fclose($fh);
}

function rate_clear(string $ip)
{
    $fh = @fopen(RATE_FILE, 'c+');
    if (!$fh) {
        return;
    }
    flock($fh, LOCK_EX);
    $data = rate_load($fh, time());
    unset($data['ip:' . $ip]);
    rate_store($fh, $data);
    flock($fh, LOCK_UN);
    fclose($fh);
}

// ---------- сессия владельца ----------
function open_session(bool $remember)
{
    ensure_storage();
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https');
    $script = isset($_SERVER['SCRIPT_NAME']) ? (string)$_SERVER['SCRIPT_NAME'] : '/api.php';
    $path = rtrim(str_replace('\\', '/', dirname($script)), '/') . '/';

    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.gc_maxlifetime', (string)SESSION_SECONDS);
    ini_set('session.gc_probability', '1');
    ini_set('session.gc_divisor', '50');
    session_save_path(STORAGE . '/sessions');
    session_name(SESSION_NAME);
    session_set_cookie_params([
        'lifetime' => $remember ? SESSION_SECONDS : 0,
        'path' => $path,
        'secure' => $https,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    if (!session_start()) {
        fail('write-failed', 500);
    }
}

function has_session_cookie(): bool
{
    return isset($_COOKIE[SESSION_NAME]) && is_string($_COOKIE[SESSION_NAME]) && $_COOKIE[SESSION_NAME] !== '';
}

function require_login(bool $needCsrf)
{
    if (!has_session_cookie()) {
        fail('unauthorized', 401);
    }
    open_session(false);
    if (empty($_SESSION['ok'])) {
        fail('unauthorized', 401);
    }
    if ($needCsrf) {
        $sent = isset($_SERVER['HTTP_X_CSRF_TOKEN']) ? (string)$_SERVER['HTTP_X_CSRF_TOKEN'] : '';
        $have = isset($_SESSION['csrf']) ? (string)$_SESSION['csrf'] : '';
        if ($have === '' || !hash_equals($have, $sent)) {
            fail('unauthorized', 403);
        }
    }
}

// ---------- проверка и запись данных ----------
function valid_csv($csv): bool
{
    if (!is_string($csv) || strlen($csv) > MAX_CSV_CHARS) {
        return false;
    }
    if (preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F]/', $csv)) {
        return false;
    }
    if (!preg_match('//u', $csv)) {
        return false; // не UTF-8
    }
    $lines = explode("\n", $csv);
    if (count($lines) > MAX_CSV_LINES) {
        return false;
    }
    $first = trim(preg_replace('/^\xEF\xBB\xBF/', '', $lines[0]));
    return $first === CSV_HEADER;
}

function write_atomic(string $path, string $content): bool
{
    $tmp = @tempnam(dirname($path), 'menu-');
    if ($tmp !== false) {
        if (@file_put_contents($tmp, $content, LOCK_EX) === strlen($content)) {
            @chmod($tmp, 0644);
            if (@rename($tmp, $path)) {
                return true;
            }
        }
        @unlink($tmp);
    }
    return @file_put_contents($path, $content, LOCK_EX) === strlen($content);
}

function prune_backups()
{
    $files = glob(STORAGE . '/backups/menu-*.csv');
    if (!$files) {
        return;
    }
    sort($files);
    while (count($files) > MAX_BACKUPS) {
        @unlink(array_shift($files));
    }
}

// ---------- обработка запросов ----------
try {
    $method = isset($_SERVER['REQUEST_METHOD']) ? (string)$_SERVER['REQUEST_METHOD'] : 'GET';
    $action = isset($_GET['action']) && is_string($_GET['action']) ? $_GET['action'] : '';

    if (!is_file(CONFIG_FILE)) {
        fail('not-configured', 500);
    }
    $config = require CONFIG_FILE;
    $ownerCode = (is_array($config) && isset($config['owner_code']) && is_string($config['owner_code'])) ? $config['owner_code'] : '';
    if ($ownerCode === '' || $ownerCode === PLACEHOLDER_CODE) {
        fail('not-configured', 500);
    }

    $route = $method . ' ' . $action;

    if ($route === 'GET state') {
        if (!has_session_cookie()) {
            respond(['loggedIn' => false]);
        }
        open_session(false);
        if (empty($_SESSION['ok'])) {
            respond(['loggedIn' => false]);
        }
        respond(['loggedIn' => true, 'csrf' => (string)$_SESSION['csrf']]);
    }

    if ($route === 'POST login') {
        ensure_storage();
        $ip = client_ip();
        if (rate_blocked($ip)) {
            fail('too-many', 429);
        }
        $body = read_json();
        $code = isset($body['code']) && is_string($body['code']) ? substr(trim($body['code']), 0, 100) : '';
        $remember = !empty($body['remember']);
        if (!hash_equals(hash('sha256', $ownerCode), hash('sha256', $code))) {
            rate_fail($ip);
            usleep(300000);
            fail('bad-code', 401);
        }
        rate_clear($ip);
        open_session($remember);
        session_regenerate_id(true);
        $_SESSION['ok'] = true;
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        respond(['csrf' => $_SESSION['csrf']]);
    }

    if ($route === 'POST logout') {
        if (has_session_cookie()) {
            open_session(false);
            $_SESSION = [];
            $p = session_get_cookie_params();
            setcookie(SESSION_NAME, '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
            session_destroy();
        }
        respond(['ok' => true]);
    }

    if ($route === 'GET menu') {
        require_login(false);
        $csv = @file_get_contents(MENU_FILE);
        if ($csv === false) {
            fail('read-failed', 500);
        }
        respond(['csv' => $csv, 'version' => sha1($csv)]);
    }

    if ($route === 'POST menu') {
        require_login(true);
        $body = read_json();
        if (!isset($body['csv']) || !valid_csv($body['csv']) || !isset($body['version']) || !is_string($body['version'])) {
            fail('bad-request', 400);
        }
        ensure_storage();
        $lock = @fopen(LOCK_FILE, 'c');
        if ($lock) {
            flock($lock, LOCK_EX);
        }
        $current = @file_get_contents(MENU_FILE);
        if ($current === false || !hash_equals(sha1($current), $body['version'])) {
            if ($lock) {
                flock($lock, LOCK_UN);
                fclose($lock);
            }
            fail('conflict', 409);
        }
        @copy(MENU_FILE, STORAGE . '/backups/menu-' . date('Ymd-His') . '.csv');
        prune_backups();
        $ok = write_atomic(MENU_FILE, $body['csv']);
        if ($lock) {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        if (!$ok) {
            fail('write-failed', 500);
        }
        respond(['version' => sha1($body['csv'])]);
    }

    if ($route === 'POST photo') {
        require_login(true);
        $body = read_json();
        $data = isset($body['data']) ? $body['data'] : null;
        if (!is_string($data) || strlen($data) > 2200000 || !preg_match('/^[A-Za-z0-9+\/]+={0,2}$/', $data)) {
            fail('bad-request', 400);
        }
        $bytes = base64_decode($data, true);
        if ($bytes === false || strlen($bytes) > MAX_PHOTO_BYTES || substr($bytes, 0, 3) !== "\xFF\xD8\xFF") {
            fail('bad-photo', 400);
        }
        $info = @getimagesizefromstring($bytes);
        if (!$info || $info[2] !== IMAGETYPE_JPEG || $info[0] < 1 || $info[1] < 1 || $info[0] > MAX_PHOTO_SIDE || $info[1] > MAX_PHOTO_SIDE) {
            fail('bad-photo', 400);
        }
        if (!is_dir(UPLOAD_DIR) && !@mkdir(UPLOAD_DIR, 0755, true)) {
            fail('write-failed', 500);
        }
        $existing = glob(UPLOAD_DIR . '/p-*.jpg');
        if ($existing && count($existing) >= MAX_UPLOADS) {
            fail('too-many-files', 400);
        }
        $name = 'p-' . bin2hex(random_bytes(6)) . '.jpg';
        $target = UPLOAD_DIR . '/' . $name;
        if (@file_put_contents($target, $bytes, LOCK_EX) !== strlen($bytes)) {
            fail('write-failed', 500);
        }
        @chmod($target, 0644);
        respond(['path' => UPLOAD_URL . '/' . $name]);
    }

    fail('not-found', 404);
} catch (Throwable $e) {
    fail('server', 500);
}

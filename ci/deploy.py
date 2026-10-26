"""Drive the constrained Terraform-created SSM documents and verify the public API from outside the instance.

Actions (argv[1]):
  deploy         upload the immutable image and run the deploy document (default)
  tunnel-status  quick_tunnel only: re-detect the current TEMPORARY tunnel URL (after reboot/restart) without redeploying
  tunnel-rotate  quick_tunnel only: restart cloudflared, which yields a NEW random URL

The verified public API URL is published to SSM Parameter Store (non-secret String) and to artifacts/, from where the
frontend job/script compiles it into the Vercel build. A Quick Tunnel URL is temporary: it changes on every restart.
"""
import hashlib, json, os, re, socket, ssl, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path
from urllib.parse import urlsplit

def aws(*args):
    return subprocess.check_output(['aws', *args, '--output', 'json'], text=True)

targets = json.loads(Path(os.environ['TARGETS_FILE']).read_text())
value = lambda key: targets[key]['value']
action = sys.argv[1] if len(sys.argv) > 1 else 'deploy'
mode = value('backend_exposure_mode')
instance = value('instance_id')
context = ssl.create_default_context()

def run_document(document, parameters):
    command = json.loads(aws('ssm', 'send-command', '--instance-ids', instance, '--document-name', document,
        '--parameters', json.dumps(parameters)))['Command']['CommandId']
    for _ in range(150):
        try:
            invocation = json.loads(aws('ssm', 'get-command-invocation', '--command-id', command, '--instance-id', instance))
        except subprocess.CalledProcessError:
            time.sleep(5)
            continue
        if invocation['Status'] == 'Success':
            return invocation
        if invocation['Status'] not in ['Pending', 'InProgress', 'Delayed']:
            print(invocation.get('StandardErrorContent', '')[-3000:], file=sys.stderr)
            raise SystemExit(f'SSM {document} failed: ' + invocation['Status'])
        time.sleep(5)
    raise SystemExit(f'SSM {document} timed out')

def public_api_url(invocation):
    if mode == 'direct_https':
        return value('backend_api_url')
    found = re.findall(r'^LUMINA_PUBLIC_API_URL=(\S+)$', invocation['StandardOutputContent'], re.M)
    if not found:
        raise SystemExit('The instance did not report a Quick Tunnel URL')
    url = urlsplit(found[-1])
    if not (url.scheme == 'https' and url.path == '/api' and url.port is None and not (url.username or url.password or url.query or url.fragment)
            and re.fullmatch(r'[a-z0-9]+(-[a-z0-9]+)*[.]trycloudflare[.]com', url.hostname or '')):
        raise SystemExit(f'Rejected tunnel URL {found[-1]!r}')
    return found[-1]

def get_json(url, attempts):
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=15, context=context) as response:
                return json.load(response)
        except (urllib.error.URLError, ssl.SSLError, ConnectionError, json.JSONDecodeError):
            if attempt == attempts - 1:
                raise
            time.sleep(5)

def reachable(host, port):
    try:
        socket.create_connection((host, port), timeout=5).close()
        return True
    except OSError:
        return False

if action == 'deploy':
    version = os.environ['GIT_COMMIT']
    archive = Path('artifacts/api.tar.gz')
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    key = f'releases/{version}/api.tar.gz'
    subprocess.run(['aws', 's3', 'cp', str(archive), f's3://{value("artifact_bucket")}/{key}', '--only-show-errors'], check=True)
    invocation = run_document(value('deploy_document'), {'ArtifactKey': [key], 'Checksum': [checksum], 'Version': [version]})
elif action in ('tunnel-status', 'tunnel-rotate') and mode == 'quick_tunnel':
    version = None
    invocation = run_document(value('tunnel_document'), {'Action': [action.removeprefix('tunnel-')]})
else:
    raise SystemExit(f'Unsupported action {action!r} for exposure mode {mode!r}')

# The instance already verified loopback health and the public path. Re-verify from here with normal TLS validation.
api = public_api_url(invocation)
host = urlsplit(api).hostname
health = get_json(api + '/health', attempts=12)
assert health.get('ok') is True and (version is None or health.get('version') == version), 'Health/version mismatch'
with socket.create_connection((host, 443), timeout=10) as raw, context.wrap_socket(raw, server_hostname=host) as tls:
    certificate = tls.getpeercert()
issuer = dict(item[0] for item in certificate['issuer'])
print('Trusted certificate:', host, 'issuer', issuer.get('organizationName'), issuer.get('commonName'), 'expires', certificate['notAfter'])
if mode == 'direct_https':
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    try:
        urllib.request.build_opener(NoRedirect).open(f'http://{host}/api/health', timeout=15)
        raise SystemExit('Plain HTTP served content instead of redirecting')
    except urllib.error.HTTPError as redirect:
        assert redirect.code in (301, 308) and redirect.headers['Location'] == f'https://{host}/api/health', 'HTTP must redirect to HTTPS'
# Nothing but the intended path may answer on the instance's live public address.
public_ip = json.loads(aws('ec2', 'describe-instances', '--instance-ids', instance))['Reservations'][0]['Instances'][0].get('PublicIpAddress')
closed = [int(value('backend_port'))] + ([80, 443] if mode == 'quick_tunnel' else [])
if public_ip:
    exposed = [port for port in closed if reachable(public_ip, port)]
    if exposed:
        raise SystemExit(f'Ports publicly reachable on the instance: {exposed}')

# Publish the verified URL (not a credential) for the frontend: SSM Parameter Store + build artifacts.
name = value('public_api_url_parameter')
try:
    previous = json.loads(aws('ssm', 'get-parameter', '--name', name))['Parameter']['Value']
except subprocess.CalledProcessError:
    previous = None
subprocess.run(['aws', 'ssm', 'put-parameter', '--name', name, '--type', 'String', '--overwrite', '--value', api], check=True, stdout=subprocess.DEVNULL)
Path('artifacts').mkdir(exist_ok=True)
Path('artifacts/public-api-url.txt').write_text(api + '\n')
frontend = {'PUBLIC_API_URL': api, 'FRONTEND_URL': value('frontend_url'), 'VERCEL_PROJECT_ID': value('vercel_project_id'),
            'VERCEL_ORG_ID': os.environ.get('VERCEL_ORG_ID') or value('vercel_team_id') or ''}
Path('artifacts/frontend.env').write_text(''.join(f'{k}={v}\n' for k, v in frontend.items()))
print(f'Verified public API ({mode}): {api}', '(changed: frontend redeploy required)' if previous != api else '(unchanged)')
if mode == 'quick_tunnel':
    print('TEMPORARY: this trycloudflare.com URL changes whenever cloudflared restarts; redeploy the frontend after any change.')

# Generates test/fixtures/ed25519-cases.json: Ed25519 edge cases for SPEC.md 10.1 step 6, each
# labelled with libsodium's verdict (PyNaCl's crypto_sign_open, libsodium's strict verifier).
# Points are built with the plain RFC 8032 arithmetic below.
#   docker run --rm -v "$PWD":/w -w /w datumesh-test python test/fixtures/gen_ed25519_cases.py
import hashlib, json
from nacl.bindings import crypto_sign_open
from nacl.exceptions import BadSignatureError

p = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
d = -121665 * pow(121666, p - 2, p) % p
I = pow(2, (p - 1) // 4, p)
def inv(x): return pow(x, p - 2, p)
def add(P, Q):
    (x1, y1, z1, t1), (x2, y2, z2, t2) = P, Q
    A = (y1 - x1) * (y2 - x2) % p; B = (y1 + x1) * (y2 + x2) % p
    C = 2 * d * t1 * t2 % p; D = 2 * z1 * z2 % p
    E, F, G, H = B - A, D - C, D + C, B + A
    return (E * F % p, G * H % p, F * G % p, E * H % p)
def mul(n, P):
    Q = (0, 1, 1, 0)
    while n:
        if n & 1: Q = add(Q, P)
        P = add(P, P); n >>= 1
    return Q
def recover_x(y, sign):
    if y >= p: return None
    x2 = (y * y - 1) * inv(d * y * y + 1) % p
    if x2 == 0: return None if sign else 0
    x = pow(x2, (p + 3) // 8, p)
    if (x * x - x2) % p: x = x * I % p
    if (x * x - x2) % p: return None
    if (x & 1) != sign: x = p - x
    return x
def decode(b, allow_noncanonical=False):
    y = int.from_bytes(b, 'little'); sign = y >> 255; y &= (1 << 255) - 1
    if y >= p:
        if not allow_noncanonical: return None
        y -= p
    x = recover_x(y, sign)
    return None if x is None else (x, y, 1, x * y % p)
def encode(P):
    x, y, z, _ = P; zi = inv(z); x, y = x * zi % p, y * zi % p
    return (y | ((x & 1) << 255)).to_bytes(32, 'little')
gy = 4 * inv(5) % p
B = (recover_x(gy, 0), gy, 1, recover_x(gy, 0) * gy % p)
def H(*parts): return int.from_bytes(hashlib.sha512(b''.join(parts)).digest(), 'little')
def keypair(seed):
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], 'little'); a &= (1 << 254) - 8; a |= 1 << 254
    return a, h[32:], encode(mul(a, B))
def sign_with(a, prefix, Abytes, msg, r=None):
    r = H(prefix, msg) % L if r is None else r
    Rb = encode(mul(r, B))
    k = H(Rb, Abytes, msg) % L
    return Rb + ((r + k * a) % L).to_bytes(32, 'little')
def libsodium(sig, msg, pub):
    try:
        crypto_sign_open(sig + msg, pub); return True
    except (BadSignatureError, Exception):
        return False

seed = bytes(range(32))
a, prefix, A = keypair(seed)
msg = b'datumesh strict ed25519'
cases = []
def case(name, sig, m, pub, why):
    cases.append({'name': name, 'why': why, 'pub': pub.hex(), 'msg': m.hex(), 'sig': sig.hex(), 'libsodium': libsodium(sig, m, pub)})

good = sign_with(a, prefix, A, msg)
case('honest', good, msg, A, 'an ordinary signature')
case('rfc8032-test1', bytes.fromhex('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'), b'', bytes.fromhex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'), 'RFC 8032 section 7.1 TEST 1')
S = int.from_bytes(good[32:], 'little')
case('s-plus-l', good[:32] + (S + L).to_bytes(32, 'little'), msg, A, 'S >= L (S + L): non-canonical scalar')
case('s-all-ones', good[:32] + b'\xff' * 32, msg, A, 'S far above L')
# Small-order points: the 8-torsion subgroup.
T8 = None
for y in range(2, 1000):
    for s in (0, 1):
        x = recover_x(y, s)
        if x is None: continue
        P = (x, y, 1, x * y % p)
        if encode(mul(8, P)) == encode((0, 1, 1, 0)) and encode(mul(4, P)) != encode((0, 1, 1, 0)):
            T8 = P; break
    if T8: break
if T8 is None:
    # Fall back to the well-known order-8 point.
    T8 = decode(bytes.fromhex('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05'))
torsion = [mul(i, T8) for i in range(8)]
assert encode(mul(8, T8)) == encode((0, 1, 1, 0)) and encode(mul(4, T8)) != encode((0, 1, 1, 0))
for i, T in enumerate(torsion):
    Tb = encode(T)
    # Small-order R with S = k*a: satisfies [S]B - [k]A = R only for R = identity (i = 0).
    k = H(Tb, A, msg) % L
    case(f'small-order-R-{i}', Tb + (k * a % L).to_bytes(32, 'little'), msg, A, f'R = {i}*T8 (small order), S = k*a')
    case(f'small-order-A-{i}', good, msg, Tb, f'A = {i}*T8 (small order)')
# Identity public key with a signature that satisfies the cofactorless equation for any R = [S]B.
ident = encode((0, 1, 1, 0))
r = 12345
Rb = encode(mul(r, B))
case('identity-A-forged', Rb + r.to_bytes(32, 'little'), msg, ident, 'A = identity: [S]B - [k]A = R holds for every message')
# Mixed-order A' = A + T8: honest-looking signature passes the cofactored equation but fails
# the cofactorless one unless k = 0 mod 8.
Am = add(decode(A), T8); Amb = encode(Am)
for n in range(64):
    m = msg + bytes([n])
    sig = sign_with(a, prefix, Amb, m)
    k = H(sig[:32], Amb, m) % L
    if k % 8:
        case('mixed-order-A-k-not-0-mod-8', sig, m, Amb, "A' = A + T8, k mod 8 != 0: cofactored equation holds, cofactorless fails"); break
for n in range(256):
    m = msg + bytes([n])
    sig = sign_with(a, prefix, Amb, m)
    k = H(sig[:32], Amb, m) % L
    if k % 8 == 0:
        case('mixed-order-A-k-0-mod-8', sig, m, Amb, "A' = A + T8, k = 0 mod 8: both equations hold"); break
# Non-canonical encodings (y + p) of points with small y.
for y in range(0, 19):
    for sgn in (0, 1):
        x = recover_x(y, sgn)
        if x is None: continue
        P = (x, y, 1, x * y % p)
        nb = ((y + p) | (sgn << 255)).to_bytes(32, 'little')
        so = encode(mul(8, P)) == encode((0, 1, 1, 0))
        case(f'noncanonical-A-y{y}-s{sgn}', good, msg, nb, f'A encoded with y + p (small order: {so})')
        case(f'noncanonical-R-y{y}-s{sgn}', nb + good[32:], msg, A, f'R encoded with y + p (small order: {so})')
# x = 0 with the sign bit set ("negative zero"): y = 1 and y = p - 1.
for y in (1, p - 1):
    nb = (y | (1 << 255)).to_bytes(32, 'little')
    case(f'neg-zero-A-y{"1" if y == 1 else "p-1"}', good, msg, nb, 'A with x = 0 and the sign bit set')
# Not a point at all.
for y in range(2, 50):
    if recover_x(y, 0) is None:
        nb = y.to_bytes(32, 'little'); break
case('A-not-on-curve', good, msg, nb, 'A is not a curve point')
case('R-not-on-curve', nb + good[32:], msg, A, 'R is not a curve point')
case('wrong-message', good, msg + b'!', A, 'signature over another message')
json.dump(cases, open('test/fixtures/ed25519-cases.json', 'w'), indent=1)
print(len(cases), 'cases;', sum(c['libsodium'] for c in cases), 'accepted by libsodium:', [c['name'] for c in cases if c['libsodium']])

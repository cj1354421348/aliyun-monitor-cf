"""生成阿里云 RPC V1 签名的已知向量，供 src/cf/test/aliyun.test.ts 对齐。

签名逻辑照抄 src/fc/index.py:298-342（FC 版线上跑通的实现）。
固定 nonce / timestamp，输出可复现的 Signature。
"""

import base64
import hashlib
import hmac
from urllib.parse import quote


def percent_encode(value):
    encoded = quote(str(value), safe="")
    return encoded.replace("+", "%20").replace("*", "%2A").replace("%7E", "~")


def build(ak, sk, version, action, params, nonce, timestamp):
    merged = {
        "Format": "JSON",
        "Version": version,
        "AccessKeyId": ak,
        "SignatureMethod": "HMAC-SHA1",
        "SignatureVersion": "1.0",
        "SignatureNonce": nonce,
        "Timestamp": timestamp,
        "Action": action,
    }
    for key, value in params.items():
        if value is None or value == "":
            continue
        merged[key] = str(value)

    canonical = "&".join(
        "%s=%s" % (percent_encode(k), percent_encode(merged[k])) for k in sorted(merged)
    )
    string_to_sign = "%s&%s&%s" % ("POST", percent_encode("/"), percent_encode(canonical))
    signature = base64.b64encode(
        hmac.new((sk + "&").encode(), string_to_sign.encode(), hashlib.sha1).digest()
    ).decode()
    return canonical, string_to_sign, signature


AK = "LTAI5tTESTACCESSKEYID"
SK = "TESTSECRETKEY0123456789abcdef"
NONCE = "b1f2c3d4-0000-4000-8000-000000000001"
TIMESTAMP = "2026-10-25T04:39:17Z"

cases = [
    (
        "ListCdtInternetTraffic",
        "2021-08-13",
        {"RegionId": "cn-hangzhou"},
    ),
    (
        "DescribeInstances",
        "2014-05-26",
        {"RegionId": "cn-hangzhou", "InstanceIds": '["i-abc123"]'},
    ),
    (
        "StopInstance",
        "2014-05-26",
        {"RegionId": "cn-hangzhou", "InstanceId": "i-abc123", "ForceStop": "true"},
    ),
]

for action, version, params in cases:
    canonical, sts, signature = build(AK, SK, version, action, params, NONCE, TIMESTAMP)
    print("action =", action)
    print("canonical =", canonical)
    print("string_to_sign =", sts)
    print("signature =", signature)
    print()

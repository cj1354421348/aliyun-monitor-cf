/**
 * 阿里云 RPC V1 签名的已知向量对齐。
 *
 * 向量由 test/gen_signature_vector.py 生成 —— 那份脚本的逻辑照抄
 * src/fc/index.py:298-342，也就是 FC 版线上跑通的实现。
 * 这里用同一组固定 nonce/timestamp 复算，两边 Signature 必须逐字节相同。
 *
 * 为什么值得单独测：签名算错时阿里云只回一句 "SignatureDoesNotMatch"，
 * 不告诉你是哪个字段拼错了。三组向量分别覆盖了
 *   - 普通参数（RegionId）
 *   - 值里带 JSON 引号与方括号（InstanceIds）
 *   - 参数排序靠前的布尔串（ForceStop）
 * 任何一处转义或排序写错都会立刻红。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCanonical, signQuery, type Credentials } from '../src/aliyun.ts';
import { percentEncode } from '../src/util.ts';

const CREDS: Credentials = {
  ak: 'LTAI5tTESTACCESSKEYID',
  sk: 'TESTSECRETKEY0123456789abcdef',
};
const NONCE = 'b1f2c3d4-0000-4000-8000-000000000001';
const TIMESTAMP = '2026-10-25T04:39:17Z';

interface Vector {
  action: string;
  version: string;
  params: Record<string, string>;
  canonical: string;
  signature: string;
}

const VECTORS: Vector[] = [
  {
    action: 'ListCdtInternetTraffic',
    version: '2021-08-13',
    params: { RegionId: 'cn-hangzhou' },
    canonical:
      'AccessKeyId=LTAI5tTESTACCESSKEYID&Action=ListCdtInternetTraffic&Format=JSON' +
      '&RegionId=cn-hangzhou&SignatureMethod=HMAC-SHA1' +
      `&SignatureNonce=${NONCE}&SignatureVersion=1.0` +
      '&Timestamp=2026-10-25T04%3A39%3A17Z&Version=2021-08-13',
    signature: 'u1tybwwsOvsfF+7H3iUFomvwZzY=',
  },
  {
    action: 'DescribeInstances',
    version: '2014-05-26',
    params: { RegionId: 'cn-hangzhou', InstanceIds: '["i-abc123"]' },
    canonical:
      'AccessKeyId=LTAI5tTESTACCESSKEYID&Action=DescribeInstances&Format=JSON' +
      '&InstanceIds=%5B%22i-abc123%22%5D&RegionId=cn-hangzhou' +
      '&SignatureMethod=HMAC-SHA1' +
      `&SignatureNonce=${NONCE}&SignatureVersion=1.0` +
      '&Timestamp=2026-10-25T04%3A39%3A17Z&Version=2014-05-26',
    signature: 'Et+kf4JFjk3/T+ED//1FcVmbKAs=',
  },
  {
    action: 'StopInstance',
    version: '2014-05-26',
    params: { RegionId: 'cn-hangzhou', InstanceId: 'i-abc123', ForceStop: 'true' },
    canonical:
      'AccessKeyId=LTAI5tTESTACCESSKEYID&Action=StopInstance&ForceStop=true&Format=JSON' +
      '&InstanceId=i-abc123&RegionId=cn-hangzhou&SignatureMethod=HMAC-SHA1' +
      `&SignatureNonce=${NONCE}&SignatureVersion=1.0` +
      '&Timestamp=2026-10-25T04%3A39%3A17Z&Version=2014-05-26',
    signature: 'K27cppGmbWyNemk8pD5lwSm8o3k=',
  },
];

for (const vector of VECTORS) {
  test(`规范化查询串与 Python 版一致：${vector.action}`, () => {
    const canonical = buildCanonical(
      CREDS,
      vector.version,
      vector.action,
      vector.params,
      NONCE,
      TIMESTAMP,
    );
    assert.equal(canonical, vector.canonical);
  });

  test(`Signature 与 Python 版一致：${vector.action}`, async () => {
    const signature = await signQuery(CREDS, vector.canonical, 'POST');
    assert.equal(signature, vector.signature);
  });
}

test('公共参数齐全，且空值参数被跳过', () => {
  const canonical = buildCanonical(
    CREDS,
    '2014-05-26',
    'DescribeInstances',
    { RegionId: 'cn-hangzhou', ResourceGroupId: '', InstanceIds: null },
    NONCE,
    TIMESTAMP,
  );
  assert.ok(canonical.includes('Format=JSON'));
  assert.ok(canonical.includes('SignatureMethod=HMAC-SHA1'));
  assert.ok(canonical.includes('SignatureVersion=1.0'));
  assert.ok(!canonical.includes('ResourceGroupId'), '空字符串参数应被跳过');
  assert.ok(!canonical.includes('InstanceIds'), 'null 参数应被跳过');
});

test('参数按 key 字典序排列', () => {
  const canonical = buildCanonical(
    CREDS,
    '2014-05-26',
    'StopInstance',
    { RegionId: 'cn-hangzhou', InstanceId: 'i-1', ForceStop: 'true' },
    NONCE,
    TIMESTAMP,
  );
  const keys = canonical.split('&').map((pair) => pair.split('=')[0]);
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
});

test('GET 与 POST 的签名不同（method 参与 StringToSign）', async () => {
  const canonical = VECTORS[0]!.canonical;
  const post = await signQuery(CREDS, canonical, 'POST');
  const get = await signQuery(CREDS, canonical, 'GET');
  assert.notEqual(post, get);
});

test('percentEncode 与 Python quote(safe="") 等价', () => {
  // 阿里云要求：空格→%20、*→%2A、~ 保持原样（标准 encodeURIComponent 会漏掉前两个）
  assert.equal(percentEncode('2014-05-26T04:39:17Z'), '2014-05-26T04%3A39%3A17Z');
  assert.equal(percentEncode('["i-abc123"]'), '%5B%22i-abc123%22%5D');
  assert.equal(percentEncode('a b'), 'a%20b');
  assert.equal(percentEncode('*'), '%2A');
  assert.equal(percentEncode('~'), '~');
});

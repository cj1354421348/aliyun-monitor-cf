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

import { billItems, buildCanonical, publicIpOf, signQuery, type Credentials } from '../src/aliyun.ts';
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

/**
 * 账单接口的 Items 有两种形状，坑就在这里：
 *   DescribeInstanceBill → Data.Items 是数组
 *   QueryBillOverview    → Data.Items 是对象，里面才是 Item 数组
 * 统一按数组处理的话，QueryBillOverview 永远取不到第一行，日报里
 * 「账户总账」就固定显示 Fail —— 线上真踩过。
 */
test('billItems：Items 是数组时原样返回', () => {
  const items = [{ PretaxAmount: 1.5, Currency: 'USD' }];
  assert.deepEqual(billItems({ Items: items }), items);
});

test('billItems：Items 是 { Item: [...] } 时取出内层数组', () => {
  const inner = [
    { PretaxAmount: 0.45, Currency: 'USD' },
    { PretaxAmount: 0.06, Currency: 'USD' },
  ];
  assert.deepEqual(billItems({ Items: { Item: inner } }), inner);
});

test('billItems：Items 是 { Item: {...} } 时包成单元素数组', () => {
  const one = { PretaxAmount: 2, Currency: 'USD' };
  assert.deepEqual(billItems({ Items: { Item: one } }), [one]);
});

test('billItems：空/畸形输入一律返回空数组', () => {
  assert.deepEqual(billItems(undefined), []);
  assert.deepEqual(billItems(null), []);
  assert.deepEqual(billItems({}), []);
  assert.deepEqual(billItems({ Items: {} }), []);
  assert.deepEqual(billItems({ Items: [] }), []);
});

/**
 * 公网 IP 的三个来源：PublicIpAddress（普通公网 IP）、EipAddress（绑定 EIP）、
 * NetworkInterfaces（专有网络弹性网卡）。线上那台机器 PublicIpAddress 是空对象，
 * 用 ?? 回落不出来，日报里就成了 "IP: -"。
 */
test('publicIpOf：优先 PublicIpAddress', () => {
  assert.equal(
    publicIpOf({ PublicIpAddress: { IpAddress: ['1.2.3.4'] }, EipAddress: { IpAddress: '5.6.7.8' } }),
    '1.2.3.4',
  );
});

test('publicIpOf：PublicIpAddress 为空对象时回落到 EipAddress', () => {
  assert.equal(publicIpOf({ PublicIpAddress: {}, EipAddress: { IpAddress: '5.6.7.8' } }), '5.6.7.8');
});

test('publicIpOf：EipAddress 为空串时继续回落到网卡主 IP', () => {
  const instance = {
    PublicIpAddress: { IpAddress: [] },
    EipAddress: { IpAddress: '   ' },
    NetworkInterfaces: { NetworkInterface: [{ PrimaryIpAddress: '9.9.9.9' }] },
  };
  assert.equal(publicIpOf(instance), '9.9.9.9');
});

test('publicIpOf：全空返回 null（渲染成 "-"，不回落内网 IP）', () => {
  assert.equal(publicIpOf(null), null);
  assert.equal(publicIpOf({}), null);
  assert.equal(publicIpOf({ InnerIpAddress: { IpAddress: ['10.0.0.1'] } }), null);
});

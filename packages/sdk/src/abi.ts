/** The subset of the HypeFuel ABI that clients need. */
export const hypeFuelAbi = [
  {
    type: "function",
    name: "fill",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          {name: "user", type: "address"},
          {name: "usdcIn", type: "uint256"},
          {name: "minHypeOut", type: "uint256"},
          {name: "validAfter", type: "uint256"},
          {name: "validBefore", type: "uint256"},
          {name: "salt", type: "bytes32"},
        ],
      },
      {name: "signature", type: "bytes"},
    ],
    outputs: [{name: "hypeOut", type: "uint256"}],
  },
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [{name: "usdcIn", type: "uint256"}],
    outputs: [
      {name: "hypeOut", type: "uint256"},
      {name: "feeUsdc", type: "uint256"},
      {name: "priceUsd1e8", type: "uint256"},
    ],
  },
  {
    type: "function",
    name: "hypePriceUsd1e8",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "feeFor",
    stateMutability: "view",
    inputs: [{name: "usdcIn", type: "uint256"}],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "config",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {name: "usdc", type: "address"},
      {name: "feeBps", type: "uint256"},
      {name: "minFeeUsdc", type: "uint256"},
      {name: "minOrderUsdc", type: "uint256"},
      {name: "maxOrderUsdc", type: "uint256"},
      {name: "maxOracleDeviationBps", type: "uint256"},
      {name: "maxFeeBps", type: "uint256"},
      {name: "paused", type: "bool"},
      {name: "hypeBalance", type: "uint256"},
    ],
  },
  {
    type: "function",
    name: "orderNonce",
    stateMutability: "pure",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          {name: "user", type: "address"},
          {name: "usdcIn", type: "uint256"},
          {name: "minHypeOut", type: "uint256"},
          {name: "validAfter", type: "uint256"},
          {name: "validBefore", type: "uint256"},
          {name: "salt", type: "bytes32"},
        ],
      },
    ],
    outputs: [{type: "bytes32"}],
  },
  {
    type: "function",
    name: "isOrderUsed",
    stateMutability: "view",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          {name: "user", type: "address"},
          {name: "usdcIn", type: "uint256"},
          {name: "minHypeOut", type: "uint256"},
          {name: "validAfter", type: "uint256"},
          {name: "validBefore", type: "uint256"},
          {name: "salt", type: "bytes32"},
        ],
      },
    ],
    outputs: [{type: "bool"}],
  },
  {
    type: "function",
    name: "availableHype",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
  {
    type: "event",
    name: "Filled",
    inputs: [
      {name: "user", type: "address", indexed: true},
      {name: "relayer", type: "address", indexed: true},
      {name: "usdcIn", type: "uint256", indexed: false},
      {name: "feeUsdc", type: "uint256", indexed: false},
      {name: "hypeOut", type: "uint256", indexed: false},
      {name: "priceUsd1e8", type: "uint256", indexed: false},
      {name: "nonce", type: "bytes32", indexed: false},
    ],
  },
  {type: "error", name: "Paused", inputs: []},
  {
    type: "error",
    name: "OrderSizeOutOfRange",
    inputs: [
      {name: "usdcIn", type: "uint256"},
      {name: "min", type: "uint256"},
      {name: "max", type: "uint256"},
    ],
  },
  {type: "error", name: "OrderNotYetValid", inputs: [{name: "validAfter", type: "uint256"}]},
  {type: "error", name: "OrderExpired", inputs: [{name: "validBefore", type: "uint256"}]},
  {
    type: "error",
    name: "InsufficientOutput",
    inputs: [
      {name: "hypeOut", type: "uint256"},
      {name: "minHypeOut", type: "uint256"},
    ],
  },
  {
    type: "error",
    name: "InsufficientLiquidity",
    inputs: [
      {name: "hypeOut", type: "uint256"},
      {name: "available", type: "uint256"},
    ],
  },
  {type: "error", name: "OracleUnavailable", inputs: []},
  {
    type: "error",
    name: "OracleDeviation",
    inputs: [
      {name: "oraclePrice", type: "uint256"},
      {name: "spotPrice", type: "uint256"},
    ],
  },
  {type: "error", name: "FeeExceedsAmount", inputs: []},
] as const;

/** The USDC reads the client needs. */
export const usdcAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{name: "account", type: "address"}],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      {name: "authorizer", type: "address"},
      {name: "nonce", type: "bytes32"},
    ],
    outputs: [{type: "bool"}],
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "bytes32"}],
  },
] as const;

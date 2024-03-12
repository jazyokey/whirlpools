import * as anchor from "@coral-xyz/anchor";
import { MathUtil, PDA } from "@orca-so/common-sdk";
import * as assert from "assert";
import Decimal from "decimal.js";
import {
  IGNORE_CACHE,
  InitPoolV2Params,
  MAX_SQRT_PRICE,
  METADATA_PROGRAM_ADDRESS,
  MIN_SQRT_PRICE,
  PDAUtil,
  PoolUtil,
  PriceMath,
  WhirlpoolContext,
  WhirlpoolData,
  WhirlpoolIx,
  toTx,
} from "../../../src";
import {
  ONE_SOL,
  TEST_TOKEN_2022_PROGRAM_ID,
  TEST_TOKEN_PROGRAM_ID,
  TickSpacing,
  ZERO_BN,
  systemTransferTx,
} from "../../utils";
import { defaultConfirmOptions } from "../../utils/const";
import { buildTestPoolV2Params, initTestPoolV2 } from "../../utils/v2/init-utils-v2";
import { TokenTrait } from "../../utils/v2/init-utils-v2";
import {
  asyncAssertOwnerProgram,
  asyncAssertTokenVaultV2,
  createMintV2,
} from "../../utils/v2/token-2022";
import { Keypair, PublicKey } from "@solana/web3.js";
import { AccountState } from "@solana/spl-token";

describe("initialize_pool_v2", () => {
  const provider = anchor.AnchorProvider.local(undefined, defaultConfirmOptions);
  const program = anchor.workspace.Whirlpool;
  const ctx = WhirlpoolContext.fromWorkspace(provider, program);
  const fetcher = ctx.fetcher;

  describe("v1 parity", () => {
    const tokenTraitVariations: { tokenTraitA: TokenTrait; tokenTraitB: TokenTrait }[] = [
      { tokenTraitA: { isToken2022: false }, tokenTraitB: { isToken2022: false } },
      { tokenTraitA: { isToken2022: true }, tokenTraitB: { isToken2022: false } },
      { tokenTraitA: { isToken2022: false }, tokenTraitB: { isToken2022: true } },
      { tokenTraitA: { isToken2022: true }, tokenTraitB: { isToken2022: true } },
    ];
    tokenTraitVariations.forEach((tokenTraits) => {
      describe(`tokenTraitA: ${
        tokenTraits.tokenTraitA.isToken2022 ? "Token2022" : "Token"
      }, tokenTraitB: ${tokenTraits.tokenTraitB.isToken2022 ? "Token2022" : "Token"}`, () => {
        it("successfully init a Standard account", async () => {
          const price = MathUtil.toX64(new Decimal(5));
          const { configInitInfo, poolInitInfo, feeTierParams } = await initTestPoolV2(
            ctx,
            tokenTraits.tokenTraitA,
            tokenTraits.tokenTraitB,
            TickSpacing.Standard,
            price
          );
          const whirlpool = (await fetcher.getPool(
            poolInitInfo.whirlpoolPda.publicKey
          )) as WhirlpoolData;

          const expectedWhirlpoolPda = PDAUtil.getWhirlpool(
            program.programId,
            configInitInfo.whirlpoolsConfigKeypair.publicKey,
            poolInitInfo.tokenMintA,
            poolInitInfo.tokenMintB,
            TickSpacing.Standard
          );

          assert.ok(poolInitInfo.whirlpoolPda.publicKey.equals(expectedWhirlpoolPda.publicKey));
          assert.equal(expectedWhirlpoolPda.bump, whirlpool.whirlpoolBump[0]);

          assert.ok(whirlpool.whirlpoolsConfig.equals(poolInitInfo.whirlpoolsConfig));

          assert.ok(whirlpool.tokenMintA.equals(poolInitInfo.tokenMintA));
          assert.ok(whirlpool.tokenVaultA.equals(poolInitInfo.tokenVaultAKeypair.publicKey));
          await asyncAssertOwnerProgram(
            provider,
            whirlpool.tokenMintA,
            tokenTraits.tokenTraitA.isToken2022 ? TEST_TOKEN_2022_PROGRAM_ID : TEST_TOKEN_PROGRAM_ID
          );

          assert.ok(whirlpool.tokenMintB.equals(poolInitInfo.tokenMintB));
          assert.ok(whirlpool.tokenVaultB.equals(poolInitInfo.tokenVaultBKeypair.publicKey));
          await asyncAssertOwnerProgram(
            provider,
            whirlpool.tokenMintB,
            tokenTraits.tokenTraitB.isToken2022 ? TEST_TOKEN_2022_PROGRAM_ID : TEST_TOKEN_PROGRAM_ID
          );

          assert.equal(whirlpool.feeRate, feeTierParams.defaultFeeRate);
          assert.equal(whirlpool.protocolFeeRate, configInitInfo.defaultProtocolFeeRate);

          assert.ok(whirlpool.sqrtPrice.eq(new anchor.BN(poolInitInfo.initSqrtPrice.toString())));
          assert.ok(whirlpool.liquidity.eq(ZERO_BN));

          assert.equal(
            whirlpool.tickCurrentIndex,
            PriceMath.sqrtPriceX64ToTickIndex(poolInitInfo.initSqrtPrice)
          );

          assert.ok(whirlpool.protocolFeeOwedA.eq(ZERO_BN));
          assert.ok(whirlpool.protocolFeeOwedB.eq(ZERO_BN));
          assert.ok(whirlpool.feeGrowthGlobalA.eq(ZERO_BN));
          assert.ok(whirlpool.feeGrowthGlobalB.eq(ZERO_BN));

          assert.ok(whirlpool.tickSpacing === TickSpacing.Standard);

          await asyncAssertTokenVaultV2(
            provider,
            poolInitInfo.tokenVaultAKeypair.publicKey,
            poolInitInfo.tokenMintA,
            poolInitInfo.whirlpoolPda.publicKey,
            tokenTraits.tokenTraitA.isToken2022 ? TEST_TOKEN_2022_PROGRAM_ID : TEST_TOKEN_PROGRAM_ID
          );
          await asyncAssertTokenVaultV2(
            provider,
            poolInitInfo.tokenVaultBKeypair.publicKey,
            poolInitInfo.tokenMintB,
            poolInitInfo.whirlpoolPda.publicKey,
            tokenTraits.tokenTraitB.isToken2022 ? TEST_TOKEN_2022_PROGRAM_ID : TEST_TOKEN_PROGRAM_ID
          );

          whirlpool.rewardInfos.forEach((rewardInfo) => {
            assert.equal(rewardInfo.emissionsPerSecondX64, 0);
            assert.equal(rewardInfo.growthGlobalX64, 0);
            assert.ok(rewardInfo.authority.equals(configInitInfo.rewardEmissionsSuperAuthority));
            assert.ok(rewardInfo.mint.equals(anchor.web3.PublicKey.default));
            assert.ok(rewardInfo.vault.equals(anchor.web3.PublicKey.default));
          });
        });

        it("successfully init a Stable account", async () => {
          const price = MathUtil.toX64(new Decimal(5));
          const { configInitInfo, poolInitInfo, feeTierParams } = await initTestPoolV2(
            ctx,
            tokenTraits.tokenTraitA,
            tokenTraits.tokenTraitB,
            TickSpacing.Stable,
            price
          );
          const whirlpool = (await fetcher.getPool(
            poolInitInfo.whirlpoolPda.publicKey
          )) as WhirlpoolData;

          assert.ok(whirlpool.whirlpoolsConfig.equals(poolInitInfo.whirlpoolsConfig));

          assert.ok(whirlpool.tokenMintA.equals(poolInitInfo.tokenMintA));
          assert.ok(whirlpool.tokenVaultA.equals(poolInitInfo.tokenVaultAKeypair.publicKey));
          await asyncAssertOwnerProgram(
            provider,
            whirlpool.tokenMintA,
            tokenTraits.tokenTraitA.isToken2022 ? TEST_TOKEN_2022_PROGRAM_ID : TEST_TOKEN_PROGRAM_ID
          );

          assert.ok(whirlpool.tokenMintB.equals(poolInitInfo.tokenMintB));
          assert.ok(whirlpool.tokenVaultB.equals(poolInitInfo.tokenVaultBKeypair.publicKey));
          await asyncAssertOwnerProgram(
            provider,
            whirlpool.tokenMintB,
            tokenTraits.tokenTraitB.isToken2022 ? TEST_TOKEN_2022_PROGRAM_ID : TEST_TOKEN_PROGRAM_ID
          );

          assert.equal(whirlpool.feeRate, feeTierParams.defaultFeeRate);
          assert.equal(whirlpool.protocolFeeRate, configInitInfo.defaultProtocolFeeRate);

          assert.ok(whirlpool.sqrtPrice.eq(new anchor.BN(poolInitInfo.initSqrtPrice.toString())));
          assert.ok(whirlpool.liquidity.eq(ZERO_BN));

          assert.equal(
            whirlpool.tickCurrentIndex,
            PriceMath.sqrtPriceX64ToTickIndex(poolInitInfo.initSqrtPrice)
          );

          assert.ok(whirlpool.protocolFeeOwedA.eq(ZERO_BN));
          assert.ok(whirlpool.protocolFeeOwedB.eq(ZERO_BN));
          assert.ok(whirlpool.feeGrowthGlobalA.eq(ZERO_BN));
          assert.ok(whirlpool.feeGrowthGlobalB.eq(ZERO_BN));

          assert.ok(whirlpool.tickSpacing === TickSpacing.Stable);

          await asyncAssertTokenVaultV2(
            provider,
            poolInitInfo.tokenVaultAKeypair.publicKey,
            poolInitInfo.tokenMintA,
            poolInitInfo.whirlpoolPda.publicKey,
            tokenTraits.tokenTraitA.isToken2022 ? TEST_TOKEN_2022_PROGRAM_ID : TEST_TOKEN_PROGRAM_ID
          );
          await asyncAssertTokenVaultV2(
            provider,
            poolInitInfo.tokenVaultBKeypair.publicKey,
            poolInitInfo.tokenMintB,
            poolInitInfo.whirlpoolPda.publicKey,
            tokenTraits.tokenTraitB.isToken2022 ? TEST_TOKEN_2022_PROGRAM_ID : TEST_TOKEN_PROGRAM_ID
          );

          whirlpool.rewardInfos.forEach((rewardInfo) => {
            assert.equal(rewardInfo.emissionsPerSecondX64, 0);
            assert.equal(rewardInfo.growthGlobalX64, 0);
            assert.ok(rewardInfo.authority.equals(configInitInfo.rewardEmissionsSuperAuthority));
            assert.ok(rewardInfo.mint.equals(anchor.web3.PublicKey.default));
            assert.ok(rewardInfo.vault.equals(anchor.web3.PublicKey.default));
          });
        });

        it("succeeds when funder is different than account paying for transaction fee", async () => {
          const funderKeypair = anchor.web3.Keypair.generate();
          await systemTransferTx(provider, funderKeypair.publicKey, ONE_SOL).buildAndExecute();
          await initTestPoolV2(
            ctx,
            tokenTraits.tokenTraitA,
            tokenTraits.tokenTraitB,
            TickSpacing.Standard,
            MathUtil.toX64(new Decimal(5)),
            funderKeypair
          );
        });

        it("fails when tokenVaultA mint does not match tokenA mint", async () => {
          const { poolInitInfo } = await buildTestPoolV2Params(
            ctx,
            tokenTraits.tokenTraitA,
            tokenTraits.tokenTraitB,
            TickSpacing.Standard
          );
          const otherTokenPublicKey = await createMintV2(provider, tokenTraits.tokenTraitA);

          const modifiedPoolInitInfo: InitPoolV2Params = {
            ...poolInitInfo,
            tokenMintA: otherTokenPublicKey,
          };

          await assert.rejects(
            toTx(
              ctx,
              WhirlpoolIx.initializePoolV2Ix(ctx.program, modifiedPoolInitInfo)
            ).buildAndExecute(),
            /custom program error: 0x7d6/ // ConstraintSeeds
          );
        });

        it("fails when tokenVaultB mint does not match tokenB mint", async () => {
          const { poolInitInfo } = await buildTestPoolV2Params(
            ctx,
            tokenTraits.tokenTraitA,
            tokenTraits.tokenTraitB,
            TickSpacing.Standard
          );
          const otherTokenPublicKey = await createMintV2(provider, tokenTraits.tokenTraitB);

          const modifiedPoolInitInfo: InitPoolV2Params = {
            ...poolInitInfo,
            tokenMintB: otherTokenPublicKey,
          };

          await assert.rejects(
            toTx(
              ctx,
              WhirlpoolIx.initializePoolV2Ix(ctx.program, modifiedPoolInitInfo)
            ).buildAndExecute(),
            /custom program error: 0x7d6/ // ConstraintSeeds
          );
        });

        it("fails when token mints are in the wrong order", async () => {
          const { poolInitInfo, configInitInfo } = await buildTestPoolV2Params(
            ctx,
            tokenTraits.tokenTraitA,
            tokenTraits.tokenTraitB,
            TickSpacing.Standard
          );

          const whirlpoolPda = PDAUtil.getWhirlpool(
            ctx.program.programId,
            configInitInfo.whirlpoolsConfigKeypair.publicKey,
            poolInitInfo.tokenMintB,
            poolInitInfo.tokenMintA,
            TickSpacing.Stable
          );

          const modifiedPoolInitInfo: InitPoolV2Params = {
            ...poolInitInfo,
            whirlpoolPda,
            tickSpacing: TickSpacing.Stable,
            tokenMintA: poolInitInfo.tokenMintB,
            tokenBadgeA: poolInitInfo.tokenBadgeB,
            tokenProgramA: tokenTraits.tokenTraitB.isToken2022
              ? TEST_TOKEN_2022_PROGRAM_ID
              : TEST_TOKEN_PROGRAM_ID,
            tokenMintB: poolInitInfo.tokenMintA,
            tokenBadgeB: poolInitInfo.tokenBadgeA,
            tokenProgramB: tokenTraits.tokenTraitA.isToken2022
              ? TEST_TOKEN_2022_PROGRAM_ID
              : TEST_TOKEN_PROGRAM_ID,
          };

          await assert.rejects(
            toTx(
              ctx,
              WhirlpoolIx.initializePoolV2Ix(ctx.program, modifiedPoolInitInfo)
            ).buildAndExecute(),
            /custom program error: 0x1788/ // InvalidTokenMintOrder
          );
        });

        it("fails when the same token mint is passed in", async () => {
          const { poolInitInfo, configInitInfo } = await buildTestPoolV2Params(
            ctx,
            tokenTraits.tokenTraitA,
            tokenTraits.tokenTraitB,
            TickSpacing.Standard
          );

          const whirlpoolPda = PDAUtil.getWhirlpool(
            ctx.program.programId,
            configInitInfo.whirlpoolsConfigKeypair.publicKey,
            poolInitInfo.tokenMintA,
            poolInitInfo.tokenMintA,
            TickSpacing.Stable
          );

          const modifiedPoolInitInfo: InitPoolV2Params = {
            ...poolInitInfo,
            whirlpoolPda,
            tickSpacing: TickSpacing.Stable,
            tokenMintB: poolInitInfo.tokenMintA,
            tokenBadgeB: poolInitInfo.tokenBadgeA,
            tokenProgramB: tokenTraits.tokenTraitA.isToken2022
              ? TEST_TOKEN_2022_PROGRAM_ID
              : TEST_TOKEN_PROGRAM_ID,
          };

          await assert.rejects(
            toTx(
              ctx,
              WhirlpoolIx.initializePoolV2Ix(ctx.program, modifiedPoolInitInfo)
            ).buildAndExecute(),
            /custom program error: 0x1788/ // InvalidTokenMintOrder
          );
        });

        it("fails when sqrt-price exceeds max", async () => {
          const { poolInitInfo } = await buildTestPoolV2Params(
            ctx,
            tokenTraits.tokenTraitA,
            tokenTraits.tokenTraitB,
            TickSpacing.Standard
          );

          const modifiedPoolInitInfo: InitPoolV2Params = {
            ...poolInitInfo,
            initSqrtPrice: new anchor.BN(MAX_SQRT_PRICE).add(new anchor.BN(1)),
          };

          await assert.rejects(
            toTx(
              ctx,
              WhirlpoolIx.initializePoolV2Ix(ctx.program, modifiedPoolInitInfo)
            ).buildAndExecute(),
            /custom program error: 0x177b/ // SqrtPriceOutOfBounds
          );
        });

        it("fails when sqrt-price subceeds min", async () => {
          const { poolInitInfo } = await buildTestPoolV2Params(
            ctx,
            tokenTraits.tokenTraitA,
            tokenTraits.tokenTraitB,
            TickSpacing.Standard
          );

          const modifiedPoolInitInfo: InitPoolV2Params = {
            ...poolInitInfo,
            initSqrtPrice: new anchor.BN(MIN_SQRT_PRICE).sub(new anchor.BN(1)),
          };

          await assert.rejects(
            toTx(
              ctx,
              WhirlpoolIx.initializePoolV2Ix(ctx.program, modifiedPoolInitInfo)
            ).buildAndExecute(),
            /custom program error: 0x177b/ // SqrtPriceOutOfBounds
          );
        });

        it("ignore passed bump", async () => {
          const { poolInitInfo } = await buildTestPoolV2Params(
            ctx,
            tokenTraits.tokenTraitA,
            tokenTraits.tokenTraitB,
            TickSpacing.Standard
          );

          const whirlpoolPda = poolInitInfo.whirlpoolPda;
          const validBump = whirlpoolPda.bump;
          const invalidBump = (validBump + 1) % 256; // +1 shift mod 256
          const modifiedWhirlpoolPda: PDA = {
            publicKey: whirlpoolPda.publicKey,
            bump: invalidBump,
          };

          const modifiedPoolInitInfo: InitPoolV2Params = {
            ...poolInitInfo,
            whirlpoolPda: modifiedWhirlpoolPda,
          };

          await toTx(
            ctx,
            WhirlpoolIx.initializePoolV2Ix(ctx.program, modifiedPoolInitInfo)
          ).buildAndExecute();

          // check if passed invalid bump was ignored
          const whirlpool = (await fetcher.getPool(
            poolInitInfo.whirlpoolPda.publicKey
          )) as WhirlpoolData;
          assert.equal(whirlpool.whirlpoolBump, validBump);
          assert.notEqual(whirlpool.whirlpoolBump, invalidBump);
        });
      });
    });
  });

  describe("v2 specific accounts", () => {
    it("fails when passed token_program_a is not token program (token-2022 is passed)", async () => {
      const { poolInitInfo } = await buildTestPoolV2Params(
        ctx,
        {isToken2022: false},
        {isToken2022: false},
        TickSpacing.Standard
      );

      assert.ok(poolInitInfo.tokenProgramA.equals(TEST_TOKEN_PROGRAM_ID));
      const modifiedPoolInitInfo: InitPoolV2Params = {
        ...poolInitInfo,
        tokenProgramA: TEST_TOKEN_2022_PROGRAM_ID,
      };

      await assert.rejects(
        toTx(
          ctx,
          WhirlpoolIx.initializePoolV2Ix(ctx.program, modifiedPoolInitInfo)
        ).buildAndExecute(),
        /incorrect program id for instruction/ // Anchor will try to create vault account
      );
    });

    it("fails when passed token_program_a is not token-2022 program (token is passed)", async () => {
      const { poolInitInfo } = await buildTestPoolV2Params(
        ctx,
        {isToken2022: true},
        {isToken2022: true},
        TickSpacing.Standard
      );

      assert.ok(poolInitInfo.tokenProgramA.equals(TEST_TOKEN_2022_PROGRAM_ID));
      const modifiedPoolInitInfo: InitPoolV2Params = {
        ...poolInitInfo,
        tokenProgramA: TEST_TOKEN_PROGRAM_ID,
      };

      await assert.rejects(
        toTx(
          ctx,
          WhirlpoolIx.initializePoolV2Ix(ctx.program, modifiedPoolInitInfo)
        ).buildAndExecute(),
        /incorrect program id for instruction/ // Anchor will try to create vault account
      );
    });

    it("fails when passed token_program_a is token_metadata", async () => {
      const { poolInitInfo } = await buildTestPoolV2Params(
        ctx,
        {isToken2022: true},
        {isToken2022: true},
        TickSpacing.Standard
      );

      assert.ok(poolInitInfo.tokenProgramA.equals(TEST_TOKEN_2022_PROGRAM_ID));
      const modifiedPoolInitInfo: InitPoolV2Params = {
        ...poolInitInfo,
        tokenProgramA: METADATA_PROGRAM_ADDRESS,
      };

      await assert.rejects(
        toTx(
          ctx,
          WhirlpoolIx.initializePoolV2Ix(ctx.program, modifiedPoolInitInfo)
        ).buildAndExecute(),
        /0xbc0/ // InvalidProgramId
      );      
    });

    it("fails when passed token_program_b is not token program (token-2022 is passed)", async () => {
      const { poolInitInfo } = await buildTestPoolV2Params(
        ctx,
        {isToken2022: false},
        {isToken2022: false},
        TickSpacing.Standard
      );

      assert.ok(poolInitInfo.tokenProgramB.equals(TEST_TOKEN_PROGRAM_ID));
      const modifiedPoolInitInfo: InitPoolV2Params = {
        ...poolInitInfo,
        tokenProgramB: TEST_TOKEN_2022_PROGRAM_ID,
      };

      await assert.rejects(
        toTx(
          ctx,
          WhirlpoolIx.initializePoolV2Ix(ctx.program, modifiedPoolInitInfo)
        ).buildAndExecute(),
        /incorrect program id for instruction/ // Anchor will try to create vault account
      );
    });

    it("fails when passed token_program_b is not token-2022 program (token is passed)", async () => {
      const { poolInitInfo } = await buildTestPoolV2Params(
        ctx,
        {isToken2022: true},
        {isToken2022: true},
        TickSpacing.Standard
      );

      assert.ok(poolInitInfo.tokenProgramB.equals(TEST_TOKEN_2022_PROGRAM_ID));
      const modifiedPoolInitInfo: InitPoolV2Params = {
        ...poolInitInfo,
        tokenProgramB: TEST_TOKEN_PROGRAM_ID,
      };

      await assert.rejects(
        toTx(
          ctx,
          WhirlpoolIx.initializePoolV2Ix(ctx.program, modifiedPoolInitInfo)
        ).buildAndExecute(),
        /incorrect program id for instruction/ // Anchor will try to create vault account
      );
    });

    it("fails when passed token_program_b is token_metadata", async () => {
      const { poolInitInfo } = await buildTestPoolV2Params(
        ctx,
        {isToken2022: true},
        {isToken2022: true},
        TickSpacing.Standard
      );

      assert.ok(poolInitInfo.tokenProgramB.equals(TEST_TOKEN_2022_PROGRAM_ID));
      const modifiedPoolInitInfo: InitPoolV2Params = {
        ...poolInitInfo,
        tokenProgramB: METADATA_PROGRAM_ADDRESS,
      };

      await assert.rejects(
        toTx(
          ctx,
          WhirlpoolIx.initializePoolV2Ix(ctx.program, modifiedPoolInitInfo)
        ).buildAndExecute(),
        /0xbc0/ // InvalidProgramId
      );
    });
  });

  describe("Supported Tokens", () => {
    function generate3MintAddress(): [Keypair, Keypair, Keypair] {
      const keypairs = [Keypair.generate(), Keypair.generate(), Keypair.generate()].sort((a, b) => PoolUtil.compareMints(a.publicKey, b.publicKey));
      return [keypairs[0], keypairs[1], keypairs[2]];
    }

    async function checkSupported(supported: boolean, whirlpoolsConfig: PublicKey, tokenMintA: PublicKey, tokenMintB: PublicKey, tickSpacing: number, anchorPatch: boolean = false) {
      const tokenVaultAKeypair = Keypair.generate();
      const tokenVaultBKeypair = Keypair.generate();

      const whirlpoolPda = PDAUtil.getWhirlpool(ctx.program.programId, whirlpoolsConfig, tokenMintA, tokenMintB, tickSpacing);
      const feeTierKey = PDAUtil.getFeeTier(ctx.program.programId, whirlpoolsConfig, tickSpacing).publicKey;
      const tokenBadgeA = PDAUtil.getTokenBadge(ctx.program.programId, whirlpoolsConfig, tokenMintA).publicKey;
      const tokenBadgeB = PDAUtil.getTokenBadge(ctx.program.programId, whirlpoolsConfig, tokenMintB).publicKey;

      const tokenProgramA = (await provider.connection.getAccountInfo(tokenMintA))!.owner;
      const tokenProgramB = (await provider.connection.getAccountInfo(tokenMintB))!.owner;

      const promise = toTx(ctx, WhirlpoolIx.initializePoolV2Ix(ctx.program, {
        tokenVaultAKeypair,
        tokenVaultBKeypair,
        funder: provider.wallet.publicKey,
        initSqrtPrice: PriceMath.tickIndexToSqrtPriceX64(0),
        tickSpacing,
        tokenMintA,
        tokenMintB,
        whirlpoolsConfig,
        feeTierKey,
        tokenBadgeA,
        tokenBadgeB,
        tokenProgramA,
        tokenProgramB,
        whirlpoolPda,
      })).buildAndExecute();

      if (supported) {
        await promise;
        const whirlpoolData = await fetcher.getPool(whirlpoolPda.publicKey, IGNORE_CACHE);
        assert.ok(whirlpoolData!.tokenMintA.equals(tokenMintA));
        assert.ok(whirlpoolData!.tokenMintB.equals(tokenMintB));
      } else {
        await assert.rejects(
          promise,
          !anchorPatch
            ? /0x179f/ // UnsupportedTokenMint
            : /invalid account data for instruction/ // Anchor v0.29 doesn't recognize some new extensions (GroupPointer, Group, MemberPointer, Member)
        );
      }
    }

    async function runTest(params: {
      supported: boolean,
      createTokenBadge: boolean,
      tokenTrait: TokenTrait,
      anchorPatch?: boolean,
    }) {
      // create tokens
      const [tokenA, tokenTarget, tokenB] = generate3MintAddress();
      await createMintV2(provider, {isToken2022: false}, undefined, tokenA);
      await createMintV2(provider, {isToken2022: false}, undefined, tokenB);
      await createMintV2(provider, params.tokenTrait, undefined, tokenTarget);

      // create config and feetier
      const configKeypair = Keypair.generate();
      await toTx(ctx, WhirlpoolIx.initializeConfigIx(ctx.program, {
        collectProtocolFeesAuthority: provider.wallet.publicKey,
        feeAuthority: provider.wallet.publicKey,
        rewardEmissionsSuperAuthority: provider.wallet.publicKey,
        defaultProtocolFeeRate: 300,
        funder: provider.wallet.publicKey,
        whirlpoolsConfigKeypair: configKeypair,
      })).addSigner(configKeypair).buildAndExecute();  

      const tickSpacing = 64;
      await toTx(ctx, WhirlpoolIx.initializeFeeTierIx(ctx.program, {
        defaultFeeRate: 3000,
        feeAuthority: provider.wallet.publicKey,
        funder: provider.wallet.publicKey,
        tickSpacing,
        whirlpoolsConfig: configKeypair.publicKey,
        feeTierPda: PDAUtil.getFeeTier(ctx.program.programId, configKeypair.publicKey, tickSpacing),
      })).buildAndExecute();

      // create token badge if wanted
      if (params.createTokenBadge) {
        const pda = PDAUtil.getConfigExtension(ctx.program.programId, configKeypair.publicKey);
        await toTx(ctx, WhirlpoolIx.initializeConfigExtensionIx(ctx.program, {
          feeAuthority: provider.wallet.publicKey,
          funder: provider.wallet.publicKey,
          whirlpoolsConfig: configKeypair.publicKey,
          whirlpoolsConfigExtensionPda: pda,
        })).buildAndExecute();
              
        const configExtension = PDAUtil.getConfigExtension(ctx.program.programId, configKeypair.publicKey).publicKey;
        const tokenBadgePda = PDAUtil.getTokenBadge(ctx.program.programId, configKeypair.publicKey, tokenTarget.publicKey);
        await toTx(ctx, WhirlpoolIx.initializeTokenBadgeIx(ctx.program, {
          whirlpoolsConfig: configKeypair.publicKey,
          whirlpoolsConfigExtension: configExtension,
          funder: provider.wallet.publicKey,
          tokenBadgeAuthority: provider.wallet.publicKey,
          tokenBadgePda,
          tokenMint: tokenTarget.publicKey,
        })).buildAndExecute();      
      }

      // try to initialize pool
      await checkSupported(params.supported, configKeypair.publicKey, tokenA.publicKey, tokenTarget.publicKey, tickSpacing, params.anchorPatch); // as TokenB
      await checkSupported(params.supported, configKeypair.publicKey, tokenTarget.publicKey, tokenB.publicKey, tickSpacing, params.anchorPatch); // as TokenA
    }

    it("Token: mint without FreezeAuthority", async () => {
      await runTest({
        supported: true,
        createTokenBadge: false,
        tokenTrait: {
            isToken2022: false,
        }
      });
    });

    it("Token: mint with FreezeAuthority", async () => {
      // not good, but allowed for compatibility to initialize_pool
      await runTest({
        supported: true,
        createTokenBadge: false,
        tokenTrait: {
            isToken2022: false,
            hasFreezeAuthority: true,
        }
      });
    });

    it("Token-2022: with TransferFeeConfig", async () => {
      await runTest({
        supported: true,
        createTokenBadge: false,
        tokenTrait: {
          isToken2022: true,
          hasTransferFeeExtension: true,
        }
      });
    });

    it("Token-2022: with MetadataPointer & TokenMetadata", async () => {
      await runTest({
        supported: true,
        createTokenBadge: false,
        tokenTrait: {
          isToken2022: true,
          hasTokenMetadataExtension: true,
          hasMetadataPointerExtension: true,
        }
      });
    });

    it("Token-2022: with ConfidentialTransferMint", async () => {
      await runTest({
        supported: true,
        createTokenBadge: false,
        tokenTrait: {
          isToken2022: true,
          hasConfidentialTransferExtension: true,
        }
      });
    });

    it("Token-2022: with TokenBadge with FreezeAuthority", async () => {
      await runTest({
        supported: true,
        createTokenBadge: true,
        tokenTrait: {
          isToken2022: true,
          hasFreezeAuthority: true,
        }
      });
    });

    it("Token-2022: with TokenBadge with PermanentDelegate", async () => {
      await runTest({
        supported: true,
        createTokenBadge: true,
        tokenTrait: {
          isToken2022: true,
          hasPermanentDelegate: true,
        }
      });
    });

    it("Token-2022: with TokenBadge with TransferHook", async () => {
      await runTest({
        supported: true,
        createTokenBadge: true,
        tokenTrait: {
          isToken2022: true,
          hasTransferHookExtension: true,
        }
      });
    });

    it("Token-2022: with TokenBadge with MintCloseAuthority", async () => { 
      await runTest({
        supported: true,
        createTokenBadge: true,
        tokenTrait: {
          isToken2022: true,
          hasMintCloseAuthorityExtension: true,
        }
      });
    });

    it("Token-2022: with TokenBadge with DefaultAccountState(Initialized)", async () => {
      await runTest({
        supported: true,
        createTokenBadge: true,
        tokenTrait: {
          isToken2022: true,
          hasDefaultAccountStateExtension: true,
          defaultAccountInitialState: AccountState.Initialized,
        }
      });
    });

    it("Token-2022: [FAIL] with TokenBadge with DefaultAccountState(Frozen)", async () => {
      await runTest({
        supported: false,
        createTokenBadge: true,
        tokenTrait: {
          isToken2022: true,
          hasFreezeAuthority: true, // needed to set initial state to Frozen
          hasDefaultAccountStateExtension: true,
          defaultAccountInitialState: AccountState.Frozen,
        }
      });
    });

    it("Token-2022: [FAIL] without TokenBadge with FreezeAuthority", async () => {
      await runTest({
        supported: false,
        createTokenBadge: false,
        tokenTrait: {
          isToken2022: true,
          hasFreezeAuthority: true,
        }
      });  
    });

    it("Token-2022: [FAIL] without TokenBadge with PermanentDelegate", async () => {
      await runTest({
        supported: false,
        createTokenBadge: false,
        tokenTrait: {
          isToken2022: true,
          hasPermanentDelegate: true,
        }
      });  
    });

    it("Token-2022: [FAIL] without TokenBadge with TransferHook", async () => {
      await runTest({
        supported: false,
        createTokenBadge: false,
        tokenTrait: {
          isToken2022: true,
          hasTransferHookExtension: true,
        }
      });
    });

    it("Token-2022: [FAIL] without TokenBadge with MintCloseAuthority", async () => {
      await runTest({
        supported: false,
        createTokenBadge: false,
        tokenTrait: {
          isToken2022: true,
          hasMintCloseAuthorityExtension: true,
        }
      });
    });

    it("Token-2022: [FAIL] without TokenBadge with DefaultAccountState(Initialized)", async () => {
      await runTest({
        supported: false,
        createTokenBadge: false,
        tokenTrait: {
          isToken2022: true,
          hasDefaultAccountStateExtension: true,
          defaultAccountInitialState: AccountState.Initialized,
        }
      });      
    });

    it("Token-2022: [FAIL] without TokenBadge with DefaultAccountState(Frozen)", async () => {
      await runTest({
        supported: false,
        createTokenBadge: false,
        tokenTrait: {
          isToken2022: true,
          hasFreezeAuthority: true, // needed to set initial state to Frozen
          hasDefaultAccountStateExtension: true,
          defaultAccountInitialState: AccountState.Frozen,
        }
      });      
    });

    it("Token-2022: [FAIL] with/without TokenBadge with InterestBearingConfig", async () => {
      const tokenTrait: TokenTrait = {
        isToken2022: true,
        hasInterestBearingExtension: true,
      };
      await runTest({ supported: false, createTokenBadge: true, tokenTrait });
      await runTest({ supported: false, createTokenBadge: false, tokenTrait });
    });

    it("Token-2022: [FAIL] with/without TokenBadge with Group", async () => {
      assert.ok(false, "[11 Mar, 2024] NOT IMPLEMENTED / I believe this extension is not stable yet");
      /*
      const tokenTrait: TokenTrait = {
        isToken2022: true,
        hasGroupExtension: true,
      };
      // TODO: remove anchorPatch: v0.29 doesn't recognize Group
      await runTest({ supported: false, createTokenBadge: true, tokenTrait, anchorPatch: true });
      await runTest({ supported: false, createTokenBadge: false, tokenTrait, anchorPatch: true });
      */
    });

    it("Token-2022: [FAIL] with/without TokenBadge with GroupPointer" , async () => {
      const tokenTrait: TokenTrait = {
        isToken2022: true,
        hasGroupPointerExtension: true,
      };
      // TODO: remove anchorPatch: v0.29 doesn't recognize GroupPointer
      await runTest({ supported: false, createTokenBadge: true, tokenTrait, anchorPatch: true });
      await runTest({ supported: false, createTokenBadge: false, tokenTrait, anchorPatch: true });
    });

    it("Token-2022: [FAIL] with/without TokenBadge with Member", async () => {
      assert.ok(false, "[11 Mar, 2024] NOT IMPLEMENTED / I believe this extension is not stable yet");
      /*
      const tokenTrait: TokenTrait = {
        isToken2022: true,
        hasGroupMemberExtension: true,
      };
      // TODO: remove anchorPatch: v0.29 doesn't recognize Member
      await runTest({ supported: false, createTokenBadge: true, tokenTrait, anchorPatch: true });
      await runTest({ supported: false, createTokenBadge: false, tokenTrait, anchorPatch: true });
      */
    });

    it("Token-2022: [FAIL] with/without TokenBadge with MemberPointer", async () => {
      const tokenTrait: TokenTrait = {
        isToken2022: true,
        hasGroupMemberPointerExtension: true,
      };
      // TODO: remove anchorPatch: v0.29 doesn't recognize MemberPointer
      await runTest({ supported: false, createTokenBadge: true, tokenTrait, anchorPatch: true });
      await runTest({ supported: false, createTokenBadge: false, tokenTrait, anchorPatch: true });
    });
    
    it("Token-2022: [FAIL] with/without TokenBadge with NonTransferable", async () => {
      const tokenTrait: TokenTrait = {
        isToken2022: true,
        hasNonTransferableExtension: true,
      };
      await runTest({ supported: false, createTokenBadge: true, tokenTrait });
      await runTest({ supported: false, createTokenBadge: false, tokenTrait });
    });
  });
});
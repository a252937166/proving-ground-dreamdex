// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ReduceOnlyGuard} from "../../src/ReduceOnlyGuard.sol";
import {ReduceGuardChecks, PositionFlippedOrIncreased, ReductionExceedsRequest} from "../../src/ReduceGuardChecks.sol";
import {Position, BookParams} from "../../src/interfaces/IDreamDex.sol";

// MOCK TESTS. Nothing here touches the real venue; these cover what a fork cannot
// reach: reentrancy through a hostile pool, constructor validation, a venue that
// reports failure, the postcondition's full input space, and the action-id vector
// shared with the TypeScript client. The venue behaviour itself is tested on a fork.

contract MockBank {
    mapping(address => mapping(address => int128)) public sizes;
    mapping(address => bool) public registered;

    function setSize(address account, address pool, int128 size) external {
        sizes[account][pool] = size;
    }

    function setRegistered(address pool, bool on) external {
        registered[pool] = on;
    }

    function getPosition(address account, address pool) external view returns (Position memory p) {
        p.size = sizes[account][pool];
    }

    function isPerpPoolRegistered(address pool) external view returns (bool) {
        return registered[pool];
    }
}

contract MockPool {
    enum Mode {
        Fill,
        Reenter,
        ReportFailure
    }

    address public marginBank;
    Mode public mode;
    ReduceOnlyGuard public guard;
    ReduceOnlyGuard.ReduceRequest internal reentry;

    constructor(address bank) {
        marginBank = bank;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setReentry(ReduceOnlyGuard g, ReduceOnlyGuard.ReduceRequest calldata r) external {
        guard = g;
        reentry = r;
    }

    function getOrderBookParameters() external pure returns (BookParams memory) {
        return BookParams({tickSize: 1e17, minQuantity: 13_000, lotSize: 1_000});
    }

    function placeOrderFor(address owner, bool isBid, uint64, uint256, uint256 quantity, uint64, uint8, uint8, address, uint96)
        external
        payable
        returns (bool, uint128)
    {
        if (mode == Mode.Reenter) guard.reduce(reentry);
        if (mode == Mode.ReportFailure) return (false, 7);
        _fill(owner, isBid, quantity);
        return (true, 1);
    }

    function _fill(address owner, bool isBid, uint256 quantity) private {
        int128 s = MockBank(marginBank).sizes(owner, address(this));
        int128 q = int128(int256(quantity));
        MockBank(marginBank).setSize(owner, address(this), isBid ? s + q : s - q);
    }
}

contract ChecksCaller {
    function check(int128 before, int128 afterSize, uint256 quantity) external pure {
        ReduceGuardChecks.checkPostcondition(before, afterSize, quantity);
    }
}

contract ReduceOnlyGuardUnitTest is Test {
    address internal owner = makeAddr("owner");
    MockBank internal bank;
    MockPool internal pool;
    ReduceOnlyGuard internal guard;
    ChecksCaller internal checks;

    function setUp() public {
        vm.chainId(50383);
        bank = new MockBank();
        pool = new MockPool(address(bank));
        bank.setRegistered(address(pool), true);
        guard = new ReduceOnlyGuard(owner, address(bank), _pools(address(pool)));
        bank.setSize(owner, address(pool), 1_000_000);
        checks = new ChecksCaller();
    }

    function _pools(address p) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = p;
    }

    function _req(uint256 qty) internal view returns (ReduceOnlyGuard.ReduceRequest memory) {
        return ReduceOnlyGuard.ReduceRequest({
            pool: address(pool),
            expectedSignedSize: 1_000_000,
            isBid: false,
            quantity: qty,
            limitPrice: 80_000e18,
            deadline: uint64(block.timestamp + 60),
            nonce: bytes32(uint256(1))
        });
    }

    function test_constructor_rejectsOtherChains() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.WrongChain.selector, 1));
        new ReduceOnlyGuard(owner, address(bank), _pools(address(pool)));
    }

    function test_constructor_rejectsForeignOrUnregisteredPools() public {
        MockPool foreign = new MockPool(address(0xB0B));
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.PoolBankMismatch.selector, address(foreign), address(0xB0B)));
        new ReduceOnlyGuard(owner, address(bank), _pools(address(foreign)));

        MockPool unregistered = new MockPool(address(bank));
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.UntrustedPool.selector, address(unregistered)));
        new ReduceOnlyGuard(owner, address(bank), _pools(address(unregistered)));

        vm.expectRevert(ReduceOnlyGuard.ZeroAddress.selector);
        new ReduceOnlyGuard(address(0), address(bank), _pools(address(pool)));
    }

    function test_reduce_mockFill() public {
        vm.prank(owner);
        (,, int128 sizeAfter) = guard.reduce(_req(500_000));
        assertEq(sizeAfter, 500_000);
    }

    /// A hostile trusted pool calling back into the guard during the order.
    function test_reentrancyIsRejected() public {
        ReduceOnlyGuard.ReduceRequest memory r = _req(500_000);
        ReduceOnlyGuard.ReduceRequest memory inner = _req(400_000);
        inner.nonce = bytes32(uint256(2));
        pool.setReentry(guard, inner);
        pool.setMode(MockPool.Mode.Reenter);
        vm.prank(owner);
        vm.expectRevert(ReduceOnlyGuard.Reentrancy.selector);
        guard.reduce(r);
        assertFalse(guard.used(guard.actionIdOf(r)));
    }

    function test_venueReportingFailure_reverts() public {
        pool.setMode(MockPool.Mode.ReportFailure);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReduceOnlyGuard.VenueRejected.selector, uint128(7)));
        guard.reduce(_req(500_000));
    }

    function test_postcondition_accepts() public view {
        checks.check(1_000, 1_000, 0); // no fill (venue would normally revert first)
        checks.check(1_000, 400, 600);
        checks.check(1_000, 0, 1_000);
        checks.check(-1_000, -400, 600);
        checks.check(-1_000, 0, 1_000);
        checks.check(0, 0, 0);
    }

    function test_postcondition_rejects() public {
        vm.expectRevert(abi.encodeWithSelector(PositionFlippedOrIncreased.selector, int128(1_000), int128(-1)));
        checks.check(1_000, -1, 1_001);
        vm.expectRevert(abi.encodeWithSelector(PositionFlippedOrIncreased.selector, int128(1_000), int128(1_001)));
        checks.check(1_000, 1_001, 1);
        vm.expectRevert(abi.encodeWithSelector(PositionFlippedOrIncreased.selector, int128(-1_000), int128(1)));
        checks.check(-1_000, 1, 1_001);
        vm.expectRevert(abi.encodeWithSelector(PositionFlippedOrIncreased.selector, int128(-1_000), int128(-1_001)));
        checks.check(-1_000, -1_001, 1);
        vm.expectRevert(abi.encodeWithSelector(PositionFlippedOrIncreased.selector, int128(0), int128(5)));
        checks.check(0, 5, 5);
        vm.expectRevert(abi.encodeWithSelector(ReductionExceedsRequest.selector, 600, 500));
        checks.check(1_000, 400, 500);
    }

    /// For any input, the check passes exactly when the result is same-side-or-flat, no
    /// larger, and reduced by at most the quantity.
    function testFuzz_postcondition(int128 before, int128 afterSize, uint64 quantity) public {
        vm.assume(before != type(int128).min && afterSize != type(int128).min);
        bool sameSide = before > 0 ? (afterSize >= 0 && afterSize <= before) : (afterSize <= 0 && afterSize >= before);
        bool ok = sameSide && ReduceGuardChecks.abs(before) - ReduceGuardChecks.abs(afterSize) <= quantity;
        if (ok) {
            checks.check(before, afterSize, quantity);
        } else {
            vm.expectRevert();
            checks.check(before, afterSize, quantity);
        }
    }

    /// The id the TypeScript client computes (test/unit/mr-action.test.ts) for the same
    /// fixed request, guard address and chain.
    function test_actionIdVector() public {
        address fixedGuard = 0x00000000000000000000000000000000000A11cE;
        address fixedOwner = 0x66C626c59EdDf06a7DCa0401cF20FA2cE7033a12;
        address bankAddr = 0x478769E1177C0773c43A593DCCc4Ad15F15F1394;
        address btc = 0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0;
        vm.etch(bankAddr, address(bank).code);
        MockBank(bankAddr).setRegistered(btc, true);
        vm.etch(btc, address(new MockPool(bankAddr)).code);
        vm.store(btc, bytes32(0), bytes32(uint256(uint160(bankAddr))));
        ReduceOnlyGuard g = new ReduceOnlyGuard(fixedOwner, bankAddr, _pools(btc));
        vm.etch(fixedGuard, address(g).code);
        ReduceOnlyGuard.ReduceRequest memory r = ReduceOnlyGuard.ReduceRequest({
            pool: btc,
            expectedSignedSize: -2_500_000,
            isBid: true,
            quantity: 1_250_000,
            limitPrice: 80_123_400_000_000_000_000_000,
            deadline: 1_793_000_000,
            nonce: keccak256("margin-rescue-vector")
        });
        bytes32 id = ReduceOnlyGuard(fixedGuard).actionIdOf(r);
        emit log_named_bytes32("action id vector", id);
        assertEq(id, 0x293396790ce17fe3193c8d02e15c8c4244e26be8c02b4b306978efc0eac3d3cf);
    }
}

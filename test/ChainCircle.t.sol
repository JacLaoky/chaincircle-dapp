// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ChainCircle} from "../contracts/ChainCircle.sol";

/// @dev Minimal subset of Foundry cheatcodes (avoids a forge-std dependency).
interface Vm {
    function prank(address) external;
    function deal(address, uint256) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
}

contract ChainCircleTest {
    bool public IS_TEST = true;
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    ChainCircle circle;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address dave = address(0xDA7E);

    uint128 constant CONTRIB = 0.01 ether;
    uint128 constant COLLATERAL = 0.02 ether;
    uint40 constant DURATION = 1 hours;

    function setUp() public {
        circle = new ChainCircle();
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
        vm.deal(dave, 10 ether);
        vm.warp(1_700_000_000);
    }

    // ---------------------------------------------------------------- helpers

    function _create(uint8 n) internal returns (uint256 id) {
        vm.prank(alice);
        id = circle.createCircle{value: COLLATERAL}("Family Circle", CONTRIB, n, DURATION);
    }

    function _join(uint256 id, address who) internal {
        vm.prank(who);
        circle.joinCircle{value: COLLATERAL}(id);
    }

    function _pay(uint256 id, address who) internal {
        vm.prank(who);
        circle.contribute{value: CONTRIB}(id);
    }

    function _activeCircle() internal returns (uint256 id) {
        id = _create(3);
        _join(id, bob);
        _join(id, carol);
    }

    function assertEq(uint256 a, uint256 b, string memory err) internal pure {
        require(a == b, err);
    }

    // ---------------------------------------------------------------- creation & validation

    function testCreateCircle() public {
        uint256 id = _create(3);
        ChainCircle.Circle memory c = circle.getCircle(id);
        assertEq(id, 1, "id");
        require(c.creator == alice, "creator");
        require(c.status == ChainCircle.Status.Open, "status");
        assertEq(circle.getMembers(id).length, 1, "creator auto-joins");
        assertEq(address(circle).balance, COLLATERAL, "collateral locked");
    }

    function testRejectEmptyName() public {
        vm.prank(alice);
        vm.expectRevert(ChainCircle.InvalidName.selector);
        circle.createCircle{value: COLLATERAL}("", CONTRIB, 3, DURATION);
    }

    function testRejectBadMemberCount() public {
        vm.prank(alice);
        vm.expectRevert(ChainCircle.InvalidMemberCount.selector);
        circle.createCircle{value: COLLATERAL}("x", CONTRIB, 1, DURATION);
        vm.prank(alice);
        vm.expectRevert(ChainCircle.InvalidMemberCount.selector);
        circle.createCircle{value: COLLATERAL}("x", CONTRIB, 13, DURATION);
    }

    function testRejectBadDuration() public {
        vm.prank(alice);
        vm.expectRevert(ChainCircle.InvalidRoundDuration.selector);
        circle.createCircle{value: COLLATERAL}("x", CONTRIB, 3, 60);
    }

    function testRejectSmallContribution() public {
        vm.prank(alice);
        vm.expectRevert(ChainCircle.ContributionTooSmall.selector);
        circle.createCircle{value: COLLATERAL}("x", 1 wei, 3, DURATION);
    }

    function testRejectSmallCollateral() public {
        vm.prank(alice);
        vm.expectRevert(ChainCircle.CollateralTooSmall.selector);
        circle.createCircle{value: CONTRIB - 1}("x", CONTRIB, 3, DURATION);
    }

    // ---------------------------------------------------------------- joining

    function testJoinStartsCircleWhenFull() public {
        uint256 id = _activeCircle();
        ChainCircle.Circle memory c = circle.getCircle(id);
        require(c.status == ChainCircle.Status.Active, "should be active");
        assertEq(c.currentRound, 1, "round 1");
        assertEq(circle.getReputation(bob).circlesJoined, 1, "rep joined");
    }

    function testJoinWrongCollateralReverts() public {
        uint256 id = _create(3);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ChainCircle.WrongAmount.selector, uint256(COLLATERAL)));
        circle.joinCircle{value: 1 ether}(id);
    }

    function testCannotJoinTwice() public {
        uint256 id = _create(3);
        _join(id, bob);
        vm.prank(bob);
        vm.expectRevert(ChainCircle.AlreadyMember.selector);
        circle.joinCircle{value: COLLATERAL}(id);
    }

    function testCannotJoinActiveCircle() public {
        uint256 id = _activeCircle();
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(ChainCircle.WrongStatus.selector, ChainCircle.Status.Active));
        circle.joinCircle{value: COLLATERAL}(id);
    }

    function testJoinUnknownCircleReverts() public {
        vm.prank(bob);
        vm.expectRevert(ChainCircle.CircleNotFound.selector);
        circle.joinCircle{value: COLLATERAL}(99);
    }

    function testLeaveRefundsCollateralAndKeepsOrder() public {
        uint256 id = _create(4);
        _join(id, bob);
        _join(id, carol);
        vm.prank(bob);
        circle.leaveCircle(id);

        address[] memory list = circle.getMembers(id);
        assertEq(list.length, 2, "len");
        require(list[0] == alice && list[1] == carol, "order preserved");
        assertEq(circle.pendingWithdrawals(bob), COLLATERAL, "refund credited");
    }

    function testCreatorCannotLeave() public {
        uint256 id = _create(3);
        vm.prank(alice);
        vm.expectRevert(ChainCircle.CreatorCannotLeave.selector);
        circle.leaveCircle(id);
    }

    function testCancelRefundsEveryone() public {
        uint256 id = _create(3);
        _join(id, bob);
        vm.prank(alice);
        circle.cancelCircle(id);
        assertEq(circle.pendingWithdrawals(alice), COLLATERAL, "alice refund");
        assertEq(circle.pendingWithdrawals(bob), COLLATERAL, "bob refund");
    }

    function testOnlyCreatorCanCancel() public {
        uint256 id = _create(3);
        vm.prank(bob);
        vm.expectRevert(ChainCircle.NotCreator.selector);
        circle.cancelCircle(id);
    }

    // ---------------------------------------------------------------- contributions

    function testContributionWrongAmountReverts() public {
        uint256 id = _activeCircle();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ChainCircle.WrongAmount.selector, uint256(CONTRIB)));
        circle.contribute{value: 1 wei}(id);
    }

    function testNonMemberCannotContribute() public {
        uint256 id = _activeCircle();
        vm.prank(dave);
        vm.expectRevert(ChainCircle.NotMember.selector);
        circle.contribute{value: CONTRIB}(id);
    }

    function testCannotPayTwice() public {
        uint256 id = _activeCircle();
        _pay(id, bob);
        vm.prank(bob);
        vm.expectRevert(ChainCircle.AlreadyPaid.selector);
        circle.contribute{value: CONTRIB}(id);
    }

    function testCannotPayAfterDeadline() public {
        uint256 id = _activeCircle();
        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(bob);
        vm.expectRevert(ChainCircle.RoundExpired.selector);
        circle.contribute{value: CONTRIB}(id);
    }

    function testFullHappyPath() public {
        uint256 id = _activeCircle();
        address[3] memory order = [alice, bob, carol];

        for (uint256 r; r < 3; ++r) {
            _pay(id, alice);
            _pay(id, bob);
            _pay(id, carol); // last payment auto-settles the round
        }

        ChainCircle.Circle memory c = circle.getCircle(id);
        require(c.status == ChainCircle.Status.Completed, "completed");
        for (uint256 i; i < 3; ++i) {
            // each member: one pot (3 * contrib) + collateral back
            assertEq(circle.pendingWithdrawals(order[i]), 3 * CONTRIB + COLLATERAL, "payout");
            assertEq(circle.getReputation(order[i]).circlesCompleted, 1, "completed rep");
            assertEq(circle.getReputation(order[i]).onTimePayments, 3, "payments rep");
        }
        assertEq(address(circle).balance, 3 * (3 * CONTRIB + COLLATERAL), "contract holds exactly what is owed");
    }

    // ---------------------------------------------------------------- defaults

    function testSettleBeforeDeadlineReverts() public {
        uint256 id = _activeCircle();
        vm.expectRevert(ChainCircle.RoundNotExpired.selector);
        circle.settleRound(id);
    }

    function testDefaultIsCoveredByCollateral() public {
        uint256 id = _activeCircle();
        _pay(id, alice);
        _pay(id, bob);
        // carol does not pay
        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(dave); // anyone can settle
        circle.settleRound(id);

        // Alice (round 1 recipient) still receives the full pot.
        assertEq(circle.pendingWithdrawals(alice), 3 * CONTRIB, "honest recipient fully paid");
        ChainCircle.Member memory m = circle.getMember(id, carol);
        assertEq(m.collateralLeft, COLLATERAL - CONTRIB, "carol slashed");
        assertEq(m.defaults, 1, "carol default count");
        assertEq(circle.getReputation(carol).defaults, 1, "carol rep default");
        assertEq(circle.getCircle(id).currentRound, 2, "next round");
    }

    function testDefaulterLosesCompletionReputation() public {
        uint256 id = _activeCircle();
        // round 1: carol defaults
        _pay(id, alice);
        _pay(id, bob);
        vm.warp(block.timestamp + DURATION + 1);
        circle.settleRound(id);
        // rounds 2 and 3: everyone pays
        for (uint256 r; r < 2; ++r) {
            _pay(id, alice);
            _pay(id, bob);
            _pay(id, carol);
        }
        require(circle.getCircle(id).status == ChainCircle.Status.Completed, "completed");
        assertEq(circle.getReputation(carol).circlesCompleted, 0, "defaulter not credited");
        assertEq(circle.getReputation(bob).circlesCompleted, 1, "honest credited");
        // carol: pot (3*contrib) + remaining collateral (collateral - contrib)
        assertEq(circle.pendingWithdrawals(carol), 3 * CONTRIB + COLLATERAL - CONTRIB, "carol final");
    }

    // ---------------------------------------------------------------- withdraw

    function testWithdraw() public {
        uint256 id = _create(3);
        _join(id, bob);
        vm.prank(bob);
        circle.leaveCircle(id);

        uint256 before = bob.balance;
        vm.prank(bob);
        circle.withdraw();
        assertEq(bob.balance - before, COLLATERAL, "withdrawn");
        assertEq(circle.pendingWithdrawals(bob), 0, "zeroed");
    }

    function testWithdrawNothingReverts() public {
        vm.prank(dave);
        vm.expectRevert(ChainCircle.NothingToWithdraw.selector);
        circle.withdraw();
    }

    function testDirectEthTransferRejected() public {
        vm.prank(dave);
        (bool ok, ) = address(circle).call{value: 1 ether}("");
        require(!ok, "plain ETH must be rejected");
    }
}
